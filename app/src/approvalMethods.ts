// Server-initiated requests we know how to render as an approval card
// (spec 7.3). Anything else surfaces as an explicit "unsupported" banner
// instead of silently (and confusingly) appearing in the approval modal
// with blank fields.
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
]);

export function isApprovalMethod(method: string): boolean {
  return APPROVAL_METHODS.has(method);
}
