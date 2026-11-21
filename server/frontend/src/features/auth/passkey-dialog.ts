/**
 * What the Passkeys dialog shows below the list. With no passkeys the add form
 * is the point of the dialog; once one exists the list leads and the form waits
 * behind "Add another passkey", unless the dialog was opened to add one.
 */
export function passkeyDialogAddArea({
  adding,
  loaded,
  hasPasskeys,
}: {
  adding: boolean;
  loaded: boolean;
  hasPasskeys: boolean;
}): "form" | "button" | "none" {
  if (adding) return "form";
  if (!loaded) return "none";
  return hasPasskeys ? "button" : "form";
}
