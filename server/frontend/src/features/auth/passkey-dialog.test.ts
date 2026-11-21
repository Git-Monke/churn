import { describe, expect, it } from "vitest";

import { passkeyDialogAddArea } from "./passkey-dialog";

describe("passkeyDialogAddArea", () => {
  it("shows the form when no passkeys are saved yet", () => {
    expect(passkeyDialogAddArea({ adding: false, loaded: true, hasPasskeys: false })).toBe("form");
  });

  it("leads with the list once a passkey exists", () => {
    expect(passkeyDialogAddArea({ adding: false, loaded: true, hasPasskeys: true })).toBe("button");
  });

  it("shows the form when asked to add one, even with passkeys saved", () => {
    expect(passkeyDialogAddArea({ adding: true, loaded: true, hasPasskeys: true })).toBe("form");
  });

  it("shows nothing to add while the list is still loading", () => {
    expect(passkeyDialogAddArea({ adding: false, loaded: false, hasPasskeys: false })).toBe("none");
  });
});
