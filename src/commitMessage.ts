/**
 * Expand the commit message template (e.g. vault backup: {{date}}).
 */
export function expandCommitMessageTemplate(
  template: string | undefined,
  formattedDate: string
): string {
  const t = template || "vault backup: {{date}}";
  return t.split("{{date}}").join(formattedDate);
}
