/**
 * @fileoverview Slide-Over Drawer component for displaying formatted candidate information.
 */

import React, { useEffect } from 'react';
import type { CandidateDetail } from '../types.js';

export interface FormattedEducation {
  degreeAndField: string;
  institution: string;
  year?: string | null;
}

export interface FormattedExperience {
  titleAndCompany: string;
  dateRange: string;
  description?: string | null;
}

export interface ClientDetails {
  awlId: string;
  name: string;
  companyEmail?: string | null;
  phone?: string | null;
  country?: string | null;
  location?: string | null;
  linkedinUrl?: string | null;
  websiteUrl?: string | null;
  githubUrl?: string | null;
  workAuth?: string | null;
  sponsorship?: string | null;
  education: FormattedEducation[];
  experience: FormattedExperience[];
}

export function formatEducationList(rawEducation: any): FormattedEducation[] {
  if (!rawEducation) return [];
  let list = rawEducation;
  if (typeof rawEducation === 'string') {
    try {
      list = JSON.parse(rawEducation);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];

  const results: FormattedEducation[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const deg = (item.degree || '').trim();
    const field = (item.fieldOfStudy || item.field_of_study || '').trim();
    const degreeAndField = deg && field ? `${deg} in ${field}` : deg || field || 'Degree';
    const institution = (item.institution || item.school || item.university || '').trim();
    const year = (item.graduationYear || item.graduation_year || item.year || '').trim() || null;

    if (!institution && degreeAndField === 'Degree') continue;
    results.push({
      degreeAndField,
      institution: institution || 'Institution',
      year,
    });
  }
  return results;
}

export function formatExperienceList(rawExperience: any): FormattedExperience[] {
  if (!rawExperience) return [];
  let list = rawExperience;
  if (typeof rawExperience === 'string') {
    try {
      list = JSON.parse(rawExperience);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];

  const results: FormattedExperience[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const title = (item.title || item.jobTitle || item.job_title || '').trim();
    const company = (item.company || item.companyName || item.company_name || '').trim();
    const titleAndCompany =
      title && company ? `${title} at ${company}` : title || company || 'Position';
    const start = (item.startDate || item.start_date || '').trim();
    const end = (item.endDate || item.end_date || '').trim() || 'Present';
    const dateRange = start ? `${start} – ${end}` : end !== 'Present' ? end : '';
    const description = (item.description || item.summary || '').trim() || null;

    if (!title && !company) continue;
    results.push({
      titleAndCompany,
      dateRange: dateRange || 'Dates not specified',
      description,
    });
  }
  return results;
}

export function extractClientDetails(candidate: CandidateDetail): ClientDetails {
  const profile: any = candidate.profile || {};
  const awlId = candidate.applywizzId || profile.applywizzId || '—';
  const name = candidate.clientName || profile.clientName || 'Candidate';
  const companyEmail = profile.companyEmail || profile.company_email || profile.email || null;
  const phone = profile.phone || null;
  const country = profile.country || null;
  const location = profile.location || null;
  const linkedinUrl = profile.linkedinUrl || profile.linkedin_url || null;
  const websiteUrl = profile.websiteUrl || profile.website_url || null;
  const githubUrl = profile.githubUrl || profile.github_url || null;
  const workAuth = profile.workAuthorization || profile.work_authorization || null;

  let sponsorship: string | null = null;
  if (profile.requiresSponsorship !== undefined || profile.requires_sponsorship !== undefined) {
    const req = profile.requiresSponsorship === true || profile.requires_sponsorship === true;
    sponsorship = req ? 'Yes (Requires Sponsorship)' : 'No (Does not require sponsorship)';
  }

  const education = formatEducationList(profile.education);
  const experience = formatExperienceList(profile.workExperience || profile.work_experience);

  return {
    awlId,
    name,
    companyEmail,
    phone,
    country,
    location,
    linkedinUrl,
    websiteUrl,
    githubUrl,
    workAuth,
    sponsorship,
    education,
    experience,
  };
}

export interface ClientInfoDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  candidate: CandidateDetail | null;
}

export const ClientInfoDrawer: React.FC<ClientInfoDrawerProps> = ({
  isOpen,
  onClose,
  candidate,
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!candidate || !isOpen) return null;
  const details = extractClientDetails(candidate);

  return (
    <>
      {/* Backdrop overlay */}
      <div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-300 opacity-100 pointer-events-auto"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-over Drawer Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Client Information"
        className="fixed inset-y-0 right-0 z-50 w-full sm:max-w-md lg:max-w-lg h-full max-h-screen bg-[#141416] border-l border-[#2c2c2e] shadow-2xl flex flex-col transform transition-transform duration-300 ease-in-out translate-x-0"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-[#1c1c1e] border-b border-[#2c2c2e] shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="text-xl">👤</span>
            <div>
              <h2 className="text-sm font-bold text-[#ffffff] uppercase tracking-wide">
                {details.name}
              </h2>
              <span className="text-[11px] font-mono text-[#0a84ff] font-semibold">
                {details.awlId}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-[#2c2c2e] hover:bg-[#3a3a3c] text-[#8e8e93] hover:text-[#ffffff] flex items-center justify-center font-bold text-sm transition-colors border border-[#3a3a3c]"
            title="Close Drawer (Esc)"
          >
            ✕
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-16 space-y-6 custom-scrollbar text-xs">
          {/* Primary Contact & Location */}
          <section className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 space-y-3">
            <h3 className="text-[11px] font-mono font-bold uppercase tracking-wider text-[#8e8e93]">
              Contact & Location
            </h3>
            <div className="space-y-2">
              {details.companyEmail && (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[#8e8e93]">Email:</span>
                  <a
                    href={`mailto:${details.companyEmail}`}
                    className="font-mono text-[#0a84ff] hover:underline break-all"
                  >
                    {details.companyEmail}
                  </a>
                </div>
              )}
              {details.phone && (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[#8e8e93]">Phone:</span>
                  <span className="font-mono text-[#ffffff]">{details.phone}</span>
                </div>
              )}
              {details.location && (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[#8e8e93]">Location:</span>
                  <span className="text-[#ffffff] text-right">{details.location}</span>
                </div>
              )}
              {details.country && (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[#8e8e93]">Country:</span>
                  <span className="text-[#ffffff] text-right">{details.country}</span>
                </div>
              )}
            </div>
          </section>

          {/* Work Authorization & Sponsorship */}
          {(details.workAuth || details.sponsorship) && (
            <section className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 space-y-3">
              <h3 className="text-[11px] font-mono font-bold uppercase tracking-wider text-[#8e8e93]">
                Eligibility & Work Authorization
              </h3>
              <div className="space-y-2">
                {details.workAuth && (
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[#8e8e93]">Work Auth:</span>
                    <span className="font-mono font-semibold text-[#30d158] bg-[#30d158]/10 border border-[#30d158]/20 px-2 py-0.5 rounded">
                      {details.workAuth}
                    </span>
                  </div>
                )}
                {details.sponsorship && (
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[#8e8e93]">Sponsorship:</span>
                    <span className="text-[#ffffff] text-right font-medium">
                      {details.sponsorship}
                    </span>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Online Profiles */}
          {(details.linkedinUrl || details.githubUrl || details.websiteUrl) && (
            <section className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 space-y-3">
              <h3 className="text-[11px] font-mono font-bold uppercase tracking-wider text-[#8e8e93]">
                Profiles & Links
              </h3>
              <div className="space-y-2">
                {details.linkedinUrl && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#8e8e93]">LinkedIn:</span>
                    <a
                      href={details.linkedinUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#0a84ff] hover:underline font-mono truncate max-w-[240px]"
                    >
                      {details.linkedinUrl} ↗
                    </a>
                  </div>
                )}
                {details.githubUrl && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#8e8e93]">GitHub:</span>
                    <a
                      href={details.githubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#0a84ff] hover:underline font-mono truncate max-w-[240px]"
                    >
                      {details.githubUrl} ↗
                    </a>
                  </div>
                )}
                {details.websiteUrl && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#8e8e93]">Website:</span>
                    <a
                      href={details.websiteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#0a84ff] hover:underline font-mono truncate max-w-[240px]"
                    >
                      {details.websiteUrl} ↗
                    </a>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Education */}
          {details.education.length > 0 && (
            <section className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 space-y-3">
              <h3 className="text-[11px] font-mono font-bold uppercase tracking-wider text-[#8e8e93]">
                Education
              </h3>
              <div className="space-y-3">
                {details.education.map((edu, idx) => (
                  <div key={idx} className="border-l-2 border-[#0a84ff] pl-3 py-0.5 space-y-0.5">
                    <p className="font-semibold text-[#ffffff]">{edu.degreeAndField}</p>
                    <p className="text-[#8e8e93]">{edu.institution}</p>
                    {edu.year && (
                      <p className="font-mono text-[10px] text-[#8e8e93]">{edu.year}</p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Work Experience */}
          {details.experience.length > 0 && (
            <section className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 space-y-3">
              <h3 className="text-[11px] font-mono font-bold uppercase tracking-wider text-[#8e8e93]">
                Work Experience
              </h3>
              <div className="space-y-3.5">
                {details.experience.map((exp, idx) => (
                  <div key={idx} className="border-l-2 border-[#30d158] pl-3 py-0.5 space-y-1">
                    <p className="font-semibold text-[#ffffff]">{exp.titleAndCompany}</p>
                    <p className="font-mono text-[10px] text-[#8e8e93]">{exp.dateRange}</p>
                    {exp.description && (
                      <p className="text-[#8e8e93] leading-relaxed text-[11px] mt-1 whitespace-pre-line">
                        {exp.description}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
};
