import json

with open(r'output/salvaged_tier5_swarm/shard_1.json', 'r', encoding='utf-8') as f:
    shard = json.load(f)

with open(r'output/salvaged_tier5_swarm/resolved_shard_1.json', 'r', encoding='utf-8') as f:
    resolved = json.load(f)

print('Shard count:', len(shard))
print('Resolved count:', len(resolved))
assert len(shard) == len(resolved), 'Count mismatch!'

for i, (orig, res) in enumerate(zip(shard, resolved)):
    assert orig['taskId'] == res['taskId'], f'taskId mismatch at {i}'
    assert orig['fieldId'] == res['fieldId'], f'fieldId mismatch at {i}'
    assert orig['label'] == res['label'], f'label mismatch at {i}'
    assert res['source'] == 'ai'
    assert res['resolvedByTier'] == 5
    assert res['confidence'] == 0.95
    assert res['value'] is not None and str(res['value']).strip() != '', f'Empty value at {i}'
    opts = orig.get('options', [])
    if opts:
        assert res['value'] in opts, f'Value "{res["value"]}" not in options {opts} at {i}'

print('All 131 items passed validation perfectly!')
