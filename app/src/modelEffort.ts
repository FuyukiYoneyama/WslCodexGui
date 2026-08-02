// Model-driven reasoning level defaults.
//
// GPT-5.6-Luna is the deep-reasoning member of the 5.6 family, so picking it
// and leaving the level at whatever was set for a lighter model wastes what it
// is for. Sol and Terra are the lighter two members, where "max" would be
// overkill but leaving the level untouched (possibly still "max" from a prior
// Luna session) is its own kind of mismatch, so they snap to "high" instead.
// Selecting any of these three only sets a default -- the user can still
// change the level afterwards, this is not a lock.
//
// Matching is on the id rather than the label because the same model arrives
// here from two places with different shapes: the pre-connect preset value
// (`gpt-5.6-luna`, or anything typed into the fallback text input) and
// model/list's own `model` field post-connect. The word boundaries keep a
// hypothetical future "lunar-*"/"terraform-*" from being caught by accident.
const LUNA_MODEL = /(^|[^a-z])luna([^a-z]|$)/i;
const SOL_OR_TERRA_MODEL = /(^|[^a-z])(sol|terra)([^a-z]|$)/i;

export function forcedEffortForModel(modelId: string | null | undefined): "max" | "high" | null {
  if (!modelId) return null;
  if (LUNA_MODEL.test(modelId)) return "max";
  if (SOL_OR_TERRA_MODEL.test(modelId)) return "high";
  return null;
}
