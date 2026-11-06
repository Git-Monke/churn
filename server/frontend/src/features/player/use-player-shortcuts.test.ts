import { describe, expect, it } from "vitest";

import { resolvePlayerShortcut } from "@/features/player/use-player-shortcuts";

const body = { tagName: "BODY" };

describe("player shortcuts", () => {
  it("maps the documented keys", () => {
    expect(resolvePlayerShortcut({ key: " ", target: body })).toBe("toggle-play");
    expect(resolvePlayerShortcut({ key: "k", target: body })).toBe("toggle-play");
    expect(resolvePlayerShortcut({ key: "K", target: body })).toBe("toggle-play");
    expect(resolvePlayerShortcut({ key: "ArrowLeft", target: body })).toBe("seek-backward");
    expect(resolvePlayerShortcut({ key: "ArrowRight", target: body })).toBe("seek-forward");
    expect(resolvePlayerShortcut({ key: "f", target: body })).toBe("fullscreen");
    expect(resolvePlayerShortcut({ key: "m", target: body })).toBe("mute");
    expect(resolvePlayerShortcut({ key: "n", target: body })).toBe("next");
    expect(resolvePlayerShortcut({ key: "q", target: body })).toBeUndefined();
  });

  it("ignores text fields and modifier chords", () => {
    expect(
      resolvePlayerShortcut({ key: " ", target: { tagName: "INPUT", type: "text" } }),
    ).toBeUndefined();
    expect(
      resolvePlayerShortcut({ key: " ", target: { tagName: "INPUT", type: "search" } }),
    ).toBeUndefined();
    expect(resolvePlayerShortcut({ key: "k", target: { tagName: "TEXTAREA" } })).toBeUndefined();
    expect(resolvePlayerShortcut({ key: "k", target: { tagName: "SELECT" } })).toBeUndefined();
    expect(
      resolvePlayerShortcut({ key: "k", target: { tagName: "DIV", isContentEditable: true } }),
    ).toBeUndefined();
    expect(resolvePlayerShortcut({ key: "k", target: body, metaKey: true })).toBeUndefined();
    expect(resolvePlayerShortcut({ key: "k", target: body, ctrlKey: true })).toBeUndefined();
    expect(resolvePlayerShortcut({ key: "k", target: body, altKey: true })).toBeUndefined();
  });

  it("keeps checkbox and button inputs working", () => {
    expect(
      resolvePlayerShortcut({ key: " ", target: { tagName: "INPUT", type: "checkbox" } }),
    ).toBe("toggle-play");
    expect(
      resolvePlayerShortcut({ key: " ", target: { tagName: "BUTTON" } }),
    ).toBe("toggle-play");
  });

  it("leaves the focused video to the native shortcuts", () => {
    expect(resolvePlayerShortcut({ key: " ", target: { tagName: "VIDEO" } })).toBeUndefined();
    expect(resolvePlayerShortcut({ key: "f", target: { tagName: "video" } })).toBeUndefined();
  });

  it("stands down while a menu or dialog is open", () => {
    expect(resolvePlayerShortcut({ key: " ", target: body }, true)).toBeUndefined();
    expect(resolvePlayerShortcut({ key: "n", target: body }, true)).toBeUndefined();
  });
});
