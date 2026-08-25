import { fmtDateTime } from '../lib/datetime.js';

// ═══════════════════════════════════════════════════════════════════════════
// The three states an audit's submitted data can be in, rendered the same way
// wherever they appear.
//
// Both sides read this from the SAME server field (`session_state`), so an
// auditor and an admin can never be looking at two different accounts of
// whether the data exists — which was the whole point of splitting the count
// from the submission.
// ═══════════════════════════════════════════════════════════════════════════
export const STATE_LABEL = {
  counting: 'Counting',
  submitted: 'Submitted',
  cleared: 'Cleared — resubmit pending',
};

const CHIP = {
  counting: 'bg-amber-100 text-amber-800 border-amber-200',
  submitted: 'bg-blue-100 text-blue-700 border-blue-200',
  cleared: 'bg-orange-100 text-orange-800 border-orange-300',
};

export function StateChip({ state }) {
  const key = STATE_LABEL[state] ? state : 'counting';
  return <span className={`chip ${CHIP[key]}`}>{STATE_LABEL[key]}</span>;
}

// The auditor's wording. They do not need to know what a snapshot is — only
// whether their work went in, and whether they need to send it again.
export function AuditorStatus({ state, submittedAt, cleared, entries }) {
  if (state === 'submitted') {
    return (
      <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3">
        <p className="font-semibold text-blue-900">Submitted {fmtDateTime(submittedAt)}</p>
        <p className="text-sm text-blue-800 mt-0.5">Your count has been sent to the admin.</p>
      </div>
    );
  }
  if (state === 'cleared') {
    return (
      <div className="rounded-xl border border-orange-300 bg-orange-50 px-4 py-3">
        <p className="font-semibold text-orange-900">
          Submitted data was cleared by admin — you can submit again
        </p>
        <p className="text-sm text-orange-800 mt-0.5">
          {cleared?.cleared_by ? `Cleared by ${cleared.cleared_by} ` : 'Cleared '}
          on {fmtDateTime(cleared?.cleared_at)}. Nothing you counted was lost —
          {entries != null ? ` all ${entries} of your entries are still here.` : ' your entries are still here.'}
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <p className="font-semibold text-amber-900">Not submitted</p>
      <p className="text-sm text-amber-800 mt-0.5">
        {entries ? `${entries} entries counted so far.` : 'Nothing counted yet.'}
      </p>
    </div>
  );
}
