import type { ProfileSnapshot } from '../../types/api'
import { profileDetailSections, selectedProfileSummary } from '../../lib/audit/enabled-checks-wording'
import { DisclosureSections } from './compact-disclosure'

/** Presentation only: the caller owns and supplies the current or saved snapshot. */
export function ProfileRequirements({ snapshot, context }: {
  snapshot: ProfileSnapshot
  context: 'current' | 'saved'
}) {
  const sections = profileDetailSections(snapshot)
  const summaries = selectedProfileSummary(snapshot)
  const overview = sections[0]
  const source = snapshot.profile_source === 'built_in' ? 'Built-in' : 'Custom'
  const coverage = sections.slice(1).map(section => {
    const heading = section.heading.startsWith('Manual') ? 'Manual review only'
      : section.heading === 'Citation style' ? 'Citation settings' : section.heading
    if (heading === 'Citation settings') return { ...section, heading, groups: [{ heading: 'Citation style', items: section.items }] }
    const summary = summaries.find(row => row.heading === section.heading || (heading === 'Manual review only' && row.heading.startsWith('Manual')))
    const meaning = heading === 'Scored checks' ? 'Enabled automatic checks affect the compliance score. These are requirements, not passed results.'
      : heading === 'Manual review only' ? 'Unscored — manual review does not affect the numeric compliance score.'
      : heading === 'Not checked' ? 'Not included in this profile’s automated checks.' : null
    return { ...section, heading, note: [summary ? `${summary.text}.` : null, meaning, section.note].filter(Boolean).join(' ') || undefined }
  })
  return (
    <div className="space-y-5" data-profile-context={context}>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {context === 'saved'
          ? 'Saved audit profile. These requirements were applied to this audit. Later profile edits or deletion do not change this snapshot.'
          : 'Currently selected profile. These requirements will be used when you run an audit; no document results are shown here.'}
      </p>
      <section aria-label="Profile overview">
        <h3 className="text-base font-semibold text-primary">Profile overview</h3>
        <p className="mt-2 break-words text-base font-medium [overflow-wrap:anywhere]">{snapshot.profile_name || 'Selected profile'}</p>
        <dl className="mt-3 space-y-2 text-[13px] leading-5">
          <div><dt className="font-medium">Source</dt><dd>{source} · {context === 'saved' ? 'Saved snapshot · Read-only' : source === 'Built-in' ? 'Read-only' : 'Independently editable'}</dd></div>
          {snapshot.profile_version != null && <div><dt className="font-medium">Version</dt><dd>{snapshot.profile_version}</dd></div>}
          {snapshot.description && <div><dt className="font-medium">Description</dt><dd>{snapshot.description}</dd></div>}
          {overview.items.filter(item => item.text.startsWith('Table classification:') || item.text.startsWith('Personal communication citations:')).map(item => (
            <div key={item.text}><dt className="font-medium">{item.text.slice(0, item.text.indexOf(':'))}</dt><dd>{item.text.slice(item.text.indexOf(':') + 2)}</dd></div>
          ))}
        </dl>
      </section>
      {!!snapshot.role_exemptions?.length && (
        <section className="border-t border-border pt-4" aria-label="Formatting exemptions">
          <h3 className="text-base font-semibold text-primary">Formatting exemptions</h3>
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">Formatting exemptions recorded by this profile.</p>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] leading-5">
            {snapshot.role_exemptions.map(role => <li key={role}>{role.charAt(0).toUpperCase() + role.slice(1).toLowerCase().replace(/_/g, ' ')}</li>)}
          </ul>
        </section>
      )}
      <DisclosureSections sections={coverage} />
      {context === 'current' && (
        <p className="border-t border-border pt-4 text-[13px] leading-5 text-muted-foreground" data-profile-scope>
          <strong className="font-medium text-foreground">Scope: </strong>
          Only enabled deterministic checks contribute to the score. Manual review requirements are unscored. Writing quality, factual accuracy and unsupported formatting requirements are not assessed.
        </p>
      )}
    </div>
  )
}
