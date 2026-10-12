// Draft/revision state machine. A revision is immutable; a change creates a new
// revision and returns the draft to `preparing`. Approved revisions are never
// rewritten in place.

export const STATES = [
  "created", "preparing", "review_ready", "approved", "publishing", "published", "cancelled",
];

const TRANSITIONS = {
  created: { register: "preparing", cancel: "cancelled" },
  preparing: { media_complete: "review_ready", cancel: "cancelled" },
  review_ready: { approve: "approved", cancel: "cancelled" },
  approved: { start_publish: "publishing", revoke: "review_ready", expire: "review_ready", cancel: "cancelled" },
  publishing: { commit: "published", fail_recoverable: "approved" },
  published: {},
  cancelled: {},
};

export class TransitionError extends Error {
  constructor(from, event) {
    super(`event '${event}' is not allowed in state '${from}'`);
    this.name = "TransitionError";
    this.from = from;
    this.event = event;
  }
}

export function transition(from, event) {
  const next = TRANSITIONS[from]?.[event];
  if (!next) throw new TransitionError(from, event);
  return next;
}

export function canTransition(from, event) {
  return Boolean(TRANSITIONS[from]?.[event]);
}
