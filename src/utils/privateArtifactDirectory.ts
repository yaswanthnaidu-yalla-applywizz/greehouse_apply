import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Secures a new artifact directory or verifies an existing one without changing it. */
export async function ensurePrivateArtifactDirectory(directoryPath: string, isNew: boolean): Promise<void> {
  const resolved = path.resolve(directoryPath);
  await assertNoSymlinkComponents(resolved);
  if (process.platform === 'win32') {
    secureWindowsArtifactDirectory(resolved, isNew);
    return;
  }

  const stats = await fs.lstat(resolved);
  if (stats.isSymbolicLink()) throw new Error('Private artifact directory cannot be a symbolic link.');
  if (!stats.isDirectory()) throw new Error('Private artifact path must be a directory.');
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error('Artifact directory is not owned by the current user.');
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`${isNew ? 'New' : 'Existing'} artifact directory is not private${isNew ? '.' : '; refusing to change its permissions.'}`);
  }
}

async function assertNoSymlinkComponents(resolved: string): Promise<void> {
  const { root } = path.parse(resolved);
  let current = root;
  for (const component of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) throw new Error('Private artifact path cannot contain a symbolic link.');
  }
}

function secureWindowsArtifactDirectory(directoryPath: string, isNew: boolean): void {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$p = [System.IO.Path]::GetFullPath($artifactPath)',
    'if (([System.IO.File]::GetAttributes($p) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Artifact path cannot be a reparse point." }',
    '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$acl = Get-Acl -LiteralPath $p',
    'if ($artifactOperation -eq "set") { $acl.SetAccessRuleProtection($true, $false); foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }; $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow); [void]$acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl }',
    '$paths = @($p) + @(Get-ChildItem -LiteralPath $p -Force -Recurse | ForEach-Object { $_.FullName })',
    'foreach ($item in $paths) { if (([System.IO.File]::GetAttributes($item) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Artifact tree cannot contain reparse points." }; $acl = Get-Acl -LiteralPath $item; if (([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw "Artifact owner is not the current user." }; $rules = @($acl.Access); if ($rules.Count -ne 1 -or $rules[0].AccessControlType -ne "Allow" -or $rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules[0].FileSystemRights -notmatch "FullControl") { throw "Artifact ACL is not user-only." } }',
  ].join('; ');
  try {
    const encodedPath = Buffer.from(directoryPath, 'utf8').toString('base64');
    const command = `$artifactPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $artifactOperation = '${isNew ? 'set' : 'verify'}'; ${script}`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'ignore', windowsHide: true });
  } catch {
    throw new Error('Unsafe Windows artifact directory blocked: could not establish and verify a current-user-only ACL.');
  }
}
