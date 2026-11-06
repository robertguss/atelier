/** Toggles a participant in or out of the review's exclusion list. */
export const toggleExcluded = (
  excluded: readonly string[],
  id: string
): string[] =>
  excluded.includes(id)
    ? excluded.filter((other) => other !== id)
    : [...excluded, id];

/** Ids of the participants still in the review, in their original order. */
export const includedParticipantIds = <Id extends string>(
  participants: readonly { _id: Id }[],
  excluded: readonly string[]
): Id[] =>
  participants.filter((p) => !excluded.includes(p._id)).map((p) => p._id);
