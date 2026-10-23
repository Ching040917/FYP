import type { ProfileSnapshot } from '../../types/api'
import { profileDetailSections, recordedRoleLabel, RECORDED_ROLE_POLICY_NOTICE } from '../../lib/audit/enabled-checks-wording'
import { DisclosureSections } from './compact-disclosure'

/** Presentation only: the caller owns and supplies the current or saved snapshot. */
export function ProfileRequirements({ snapshot, context }: {
  snapshot: ProfileSnapshot
  context: 'current' | 'saved'
}) {
  const sections = profileDetailSections(snapshot)
  const overview = sections[0]
  const source = snapshot.profile_source === 'built_in' ? 'Built-in'
    : snapshot.profile_source === 'custom' ? 'Custom' : snapshot.profile_source?.trim() || 'Not recorded'
  const exemptions = [...new Set((snapshot.role_exemptions ?? []).filter(role => typeof role === 'string' && role.trim().length > 0))]
  const coverage = sections.slice(1).filter(section => section.heading !== 'Citation style').map(section => {
    const heading = section.heading.startsWith('Manual') ? 'Manual review only' : section.heading
    const meaning = heading === 'Scored checks' ? 'Enabled automatic checks affect the compliance score. These are requirements, not passed results.'
      : heading === 'Manual review only' ? 'Unscored — manual review does not affect the numeric compliance score.'
      : 'Not included in this profile’s automated checks. These are not failed requirements.'
    const count = section.items.length
    return { ...section, heading, note: [`${count} configured item${count === 1 ? '' : 's'}.`, meaning, section.note].filter(Boolean).join(' ') }
  })
  return (
    <div className="space-y-5" data-profile-context={context}>
      <section aria-label="Profile overview">
        <h3 className="text-base font-semibold text-primary">Profile overview</h3>
        <p className="mt-2 break-words text-base font-medium [overflow-wrap:anywhere]">{snapshot.profile_name || 'Selected profile'}</p>
        <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] leading-5">
          <div className="flex min-w-0 flex-wrap gap-x-2"><dt className="font-medium">Source</dt><dd>{source} · {context === 'saved' ? 'Saved snapshot · Read-only' : 'Read-only'}</dd></div>
          {snapshot.profile_version != null && <div className="flex gap-x-2"><dt className="font-medium">Version</dt><dd>{snapshot.profile_version}</dd></div>}
        </dl>
      </section>
      <DisclosureSections sections={coverage} />
      <section className="border-t border-border pt-4" aria-label="Formatting exemptions">
          <h3 className="text-base font-semibold text-primary">Formatting exemptions</h3>
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{RECORDED_ROLE_POLICY_NOTICE}</p>
          {exemptions.length === 0 && (
            <p className="mt-2 text-[13px] leading-5 text-muted-foreground">
              {snapshot.role_exemptions == null
                ? 'Exemptions were not recorded in this configuration.'
                : 'No exemptions are recorded by this profile. The fixed eligibility policy still applies.'}
            </p>
          )}
          {exemptions.length > 0 && <ul
            role="list"
            aria-label="Formatting exemptions"
            className="mt-2 flex flex-wrap items-start gap-2 text-[13px] leading-5"
          >
            {exemptions.map(role => (
              <li
                key={role}
                className="min-w-0 max-w-full rounded-md bg-muted px-2 py-1 text-foreground [overflow-wrap:anywhere]"
              >
                {recordedRoleLabel(role)}
              </li>
            ))}
          </ul>}
      </section>
      <section className="border-t border-border pt-4" aria-label="Profile information">
        <h3 className="text-base font-semibold text-primary">Profile information</h3>
        <dl className="mt-3 space-y-2 text-[13px] leading-5">
          <div><dt className="font-medium">Citation style</dt><dd>{snapshot.citation_style || 'Not recorded'}</dd></div>
          {overview.items.filter(item => item.text.startsWith('Table classification:') || item.text.startsWith('Personal communication citations:')).map(item => (
            <div key={item.text}><dt className="font-medium">{item.text.slice(0, item.text.indexOf(':'))}</dt><dd>{item.text.slice(item.text.indexOf(':') + 2)}</dd></div>
          ))}
        </dl>
        {snapshot.description && (
          <details className="mt-3 text-[13px] leading-5">
            <summary className="w-fit max-w-full cursor-pointer rounded-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Profile description</summary>
            <p className="mt-2 text-muted-foreground [overflow-wrap:anywhere]">{snapshot.description}</p>
          </details>
        )}
      </section>
      {context === 'current' && (
        <p className="border-t border-border pt-4 text-[13px] leading-5 text-muted-foreground" data-profile-scope>
          <strong className="font-medium text-foreground">Scope: </strong>
          Only enabled deterministic checks contribute to the score. Manual review requirements are unscored. Writing quality, factual accuracy and unsupported formatting requirements are not assessed.
        </p>
      )}
    </div>
  )
}
