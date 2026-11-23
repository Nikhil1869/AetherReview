import React from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runReview } from "../../engine/pipeline.js";
import { watch } from "../../engine/watch.js";
import { Dashboard } from "../Dashboard.js";

vi.mock("../../engine/viewer.js", () => ({
  fetchPrList: vi.fn(async (_forge, _repo, state) =>
    state === "open" ? [{ iid: 1, title: "fixture PR", headSha: "fixture-head" }] : [],
  ),
}));
vi.mock("../../engine/watch.js", () => ({ watch: vi.fn(async () => {}) }));
vi.mock("../../engine/pipeline.js", () => ({
  runReview: vi.fn(async () => ({
    status: "completed",
    headSha: "fixture-head",
    omittedFiles: 0,
    result: { summary: "No findings above the confidence threshold.", findings: [] },
  })),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("dashboard review controls", () => {
  it("previews with Enter and starts automatic posting only after authorization", async () => {
    vi.stubEnv("REVIEWER_BASE_URL", "http://127.0.0.1:1234/v1");
    const app = render(
      React.createElement(Dashboard, {
        repo: { forge: "github", projectId: "o/r" },
        onChangeRepo: () => {},
        onReset: () => {},
      }),
    );
    try {
      await vi.waitFor(() => expect(app.lastFrame()).toContain("fixture PR"));
      expect(watch).not.toHaveBeenCalled();
      app.stdin.write("\r");
      await vi.waitFor(() => expect(app.lastFrame()).toContain("review preview"));
      expect(runReview).toHaveBeenCalledWith(
        { forge: "github", projectId: "o/r", prNumber: 1 },
        expect.any(Function),
        { publish: false },
      );
      app.stdin.write("\x1b");
      await vi.waitFor(() => expect(app.lastFrame()).toContain("fixture PR"));
      app.stdin.write("a");
      await vi.waitFor(() => expect(app.lastFrame()).toContain("authorize automatic posting"));
      expect(app.lastFrame()).toContain("github:o/r");
      expect(watch).not.toHaveBeenCalled();
      app.stdin.write("\r");
      await vi.waitFor(() =>
        expect(watch).toHaveBeenCalledWith(
          ["github:o/r"],
          expect.objectContaining({ publish: true }),
        ),
      );
    } finally {
      app.unmount();
    }
  });
});
