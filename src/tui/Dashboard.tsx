/** Dashboard for the chosen repo: opened/closed PR lists fetched live, with the
 * opt-in watcher for new PRs and pushes. */

import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { stripVTControlCharacters } from "node:util";

import {
  loadConfig,
  loadCredentials,
  parseReviewerEndpoint,
  resetLogin,
  reviewerConfigured,
  reviewerSettings,
  reviewTokenLimit,
  updateConfig,
} from "../engine/config.js";
import { runReview, type ReviewOutcome } from "../engine/pipeline.js";
import { fetchPrList, type PrSummary } from "../engine/viewer.js";
import { watch } from "../engine/watch.js";
import { PrList, type PrStatus } from "./dashboard/PrList.js";
import { SettingsOverlay, type SettingsView } from "./dashboard/SettingsOverlay.js";
import { ModelPicker } from "./ModelPicker.js";
import { RepoPicker } from "./RepoPicker.js";
import type { RepoRef } from "./RepoScreen.js";
import { ReviewViewer } from "./ReviewViewer.js";
import { ACCENT, DIM, Header, KeyHint } from "./theme.js";

type Overlay =
  | "none"
  | "settings"
  | "general"
  | "tokenLimit"
  | "model"
  | "repos"
  | "confirmReset"
  | "viewReview"
  | "preview"
  | "confirmWatch";

type Tab = "open" | "closed";

const ts = () => new Date().toLocaleTimeString();

export function Dashboard({
  repo,
  onChangeRepo,
  onReset,
}: {
  repo: RepoRef;
  onChangeRepo: () => void;
  onReset: () => void;
}) {
  const { exit } = useApp();
  const [tab, setTab] = useState<Tab>("open");
  const [openPrs, setOpenPrs] = useState<PrSummary[] | null>(null);
  const [closedPrs, setClosedPrs] = useState<PrSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [statuses, setStatuses] = useState<Record<number, PrStatus>>({});
  const [events, setEvents] = useState<string[]>([]);
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [model, setModel] = useState(reviewerSettings().model);
  const [passes, setPasses] = useState(reviewerSettings().passes);
  const [tokenLimit, setTokenLimit] = useState(reviewTokenLimit());
  const [pendingPr, setPendingPr] = useState<{ number: number; publish: boolean } | null>(null);
  const [viewPr, setViewPr] = useState<number | null>(null);
  const [preview, setPreview] = useState<Extract<ReviewOutcome, { status: "completed" }> | null>(
    null,
  );
  const [previewIndex, setPreviewIndex] = useState(0);
  const [watchTargets, setWatchTargets] = useState<string[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const creds = loadCredentials();
  const target = `${repo.forge}:${repo.projectId}`;
  const candidateTargets = [...new Set([target, ...(loadConfig().watch?.targets ?? [])])];
  const interval = loadConfig().watch?.interval ?? 30;
  const endpoint = parseReviewerEndpoint(reviewerSettings().baseUrl);

  const setStatus = useCallback((prNumber: number, s: PrStatus) => {
    setStatuses((prev) => ({ ...prev, [prNumber]: s }));
  }, []);

  const addEvent = useCallback((msg: string) => {
    setEvents((prev) => [...prev.slice(-49), `${ts()}  ${msg}`]);
  }, []);

  // pipeline/watcher log → events feed + per-PR status
  const reviewLog = useCallback(
    (msg: string) => {
      addEvent(msg);
      const found = msg.match(/pr=(\d+) found=\d+ kept=(\d+)/);
      if (found) setStatus(Number(found[1]), { status: "done", detail: `${found[2]} findings` });
      const failed = msg.match(/review failed pr=(\d+)/);
      if (failed) setStatus(Number(failed[1]), { status: "failed", detail: msg.slice(0, 60) });
      // early pipeline exits — without these the row sticks on "reviewing…"
      const skipped = msg.match(
        /pr=(\d+) (nothing to review|all changed files excluded|superseded|already locked|no patches available|cancelled)/,
      );
      if (skipped) setStatus(Number(skipped[1]), { status: "done", detail: skipped[2] });
    },
    [addEvent, setStatus],
  );

  const loadPrs = useCallback(async () => {
    setListError(null);
    setOpenPrs(null);
    setClosedPrs(null);
    setActiveIndex(0);
    try {
      const [open, closed] = await Promise.all([
        fetchPrList(repo.forge, repo.projectId, "open"),
        fetchPrList(repo.forge, repo.projectId, "closed"),
      ]);
      setOpenPrs(open);
      setClosedPrs(closed);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "failed to load PRs");
      setOpenPrs([]);
      setClosedPrs([]);
    }
  }, [repo.forge, repo.projectId]);

  useEffect(() => {
    void loadPrs();
  }, [loadPrs]);

  // refresh (manual R or auto-timer): refetch both lists in place — no loading wipe,
  // selection kept. A PR raised, closed or merged after the dashboard opened shows up
  // here; silent mode keeps a flaky network from spamming the events feed.
  const refreshAll = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (refreshing) return;
      setRefreshing(true);
      try {
        const [open, closed] = await Promise.all([
          fetchPrList(repo.forge, repo.projectId, "open"),
          fetchPrList(repo.forge, repo.projectId, "closed"),
        ]);
        setListError(null);
        setOpenPrs(open);
        setClosedPrs(closed);
        // selection may point past the end if the active list shrank
        const current = tab === "open" ? open : closed;
        setActiveIndex((i) => Math.min(i, Math.max(0, current.length - 1)));
      } catch (e) {
        if (!opts?.silent) addEvent(`refresh failed: ${e instanceof Error ? e.message : e}`);
      } finally {
        setRefreshing(false);
      }
    },
    [refreshing, repo.forge, repo.projectId, tab, addEvent],
  );

  // auto-refresh both lists on the watch cadence: the watcher only signals new
  // jobs (new PR / push), so closes, merges and title edits need their own poll.
  const refreshAllRef = useRef(refreshAll);
  useEffect(() => {
    refreshAllRef.current = refreshAll;
  }, [refreshAll]);
  useEffect(() => {
    const id = setInterval(() => void refreshAllRef.current({ silent: true }), interval * 1000);
    return () => clearInterval(id);
  }, [interval]);

  // a new PR raised while watching should appear in the open list
  const refreshOpen = useCallback(async () => {
    try {
      setOpenPrs(await fetchPrList(repo.forge, repo.projectId, "open"));
    } catch {
      // soft refresh — keep the current list on failure
    }
  }, [repo.forge, repo.projectId]);

  useEffect(() => {
    if (!watchTargets) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    void watch(watchTargets, {
      intervalSec: interval,
      publish: true,
      log: reviewLog,
      signal: ctrl.signal,
      onJob: (job) => {
        if (`${job.forge}:${job.projectId}` === target) {
          setStatus(job.prNumber, { status: "running", detail: "auto · reviewing…" });
          void refreshOpen();
        }
      },
    }).catch(() => {
      if (ctrl.signal.aborted) return;
      addEvent("watcher stopped after an error");
      setWatchTargets(null);
    });
    return () => {
      ctrl.abort();
      abortRef.current = null;
    };
  }, [watchTargets, interval, target, addEvent, refreshOpen, reviewLog, setStatus]);

  const runOn = useCallback(
    (prNumber: number, publish: boolean) => {
      setStatus(prNumber, { status: "running", detail: "fetching…" });
      void runReview({ forge: repo.forge, projectId: repo.projectId, prNumber }, reviewLog, {
        publish,
      }).then((outcome) => {
        if (outcome.status === "completed" && !publish) {
          setPreview(outcome);
          setPreviewIndex(0);
          setOverlay((current) => (current === "none" ? "preview" : current));
        }
      });
    },
    [repo.forge, repo.projectId, reviewLog, setStatus],
  );

  const startReview = useCallback(
    (prNumber: number, publish = false) => {
      if (!reviewerConfigured()) {
        // safety net — model is normally set once right after login
        setPendingPr({ number: prNumber, publish });
        setOverlay("model");
        return;
      }
      runOn(prNumber, publish);
    },
    [runOn],
  );

  const list = tab === "open" ? openPrs : closedPrs;
  const selected = list?.[activeIndex] ?? null;

  useInput((input, key) => {
    if (overlay === "none") {
      if (key.tab || key.leftArrow || key.rightArrow) {
        setTab((t) => (t === "open" ? "closed" : "open"));
        setActiveIndex(0);
      } else if ((input === "j" || key.downArrow) && list?.length) {
        setActiveIndex((i) => (i + 1) % list.length);
      } else if ((input === "k" || key.upArrow) && list?.length) {
        setActiveIndex((i) => (i - 1 + list.length) % list.length);
      } else if (key.return && selected) {
        if (tab === "open") startReview(selected.iid);
        else {
          setViewPr(selected.iid);
          setOverlay("viewReview");
        }
      } else if (input === "p" && tab === "open" && selected) {
        startReview(selected.iid, true);
      } else if (input === "a") {
        if (watchTargets) {
          abortRef.current?.abort();
          setWatchTargets(null);
        } else setOverlay("confirmWatch");
      } else if (input === "v" && selected) {
        setViewPr(selected.iid);
        setOverlay("viewReview");
      } else if (input === "R") {
        void refreshAll();
      } else if (input === "r") {
        abortRef.current?.abort();
        onChangeRepo();
      } else if (input === "s") {
        setOverlay("settings");
      }
    } else if (overlay === "confirmWatch") {
      if (key.return) setWatchTargets(candidateTargets);
      if (key.return || key.escape) setOverlay("none");
    } else if (overlay === "preview") {
      if (key.escape) setOverlay("none");
      if (key.downArrow || input === "j") {
        setPreviewIndex((index) =>
          Math.min(index + 1, Math.max(0, (preview?.result.findings.length ?? 0) - 1)),
        );
      }
      if (key.upArrow || input === "k") setPreviewIndex((index) => Math.max(0, index - 1));
    } else if (overlay === "settings" && key.escape) {
      setOverlay("none");
    } else if (overlay === "general" && key.escape) {
      setOverlay("settings");
    } else if (overlay === "tokenLimit" && key.escape) {
      setOverlay("general");
    }
  });

  // ---- overlays ----------------------------------------------------------------

  if (overlay === "model") {
    return (
      <Box flexDirection="column">
        <Header subtitle={pendingPr ? "Pick a model to start reviewing" : "Change review model"} />
        <ModelPicker
          onDone={(c) => {
            updateConfig("reviewer", {
              provider: c.provider,
              api_key: c.apiKey,
              base_url: c.baseUrl,
              model: c.model,
              token_limit: c.tokenLimit,
            });
            setModel(c.model);
            setTokenLimit(c.tokenLimit);
            setOverlay("none");
            if (pendingPr != null) {
              runOn(pendingPr.number, pendingPr.publish);
              setPendingPr(null);
            }
          }}
        />
      </Box>
    );
  }

  if (overlay === "confirmWatch") {
    return (
      <Box flexDirection="column">
        <Header subtitle="authorize automatic posting" />
        <Text>
          post reviews for new PRs and branch pushes in these repositories during this session?
        </Text>
        {candidateTargets.map((name) => (
          <Text key={name} color={DIM}>
            {stripVTControlCharacters(name)}
          </Text>
        ))}
        <KeyHint
          keys={[
            ["enter", "authorize"],
            ["esc", "cancel"],
          ]}
        />
      </Box>
    );
  }

  if (overlay === "preview" && preview) {
    const finding = preview.result.findings[previewIndex];
    return (
      <Box flexDirection="column">
        <Header subtitle={`review preview · ${preview.headSha.slice(0, 12)}`} />
        <Text>{preview.result.summary}</Text>
        {preview.omittedFiles ? (
          <Text color={DIM}>{preview.omittedFiles} changed file(s) unavailable or over budget</Text>
        ) : null}
        {finding ? (
          <Box marginY={1} flexDirection="column">
            <Text color={ACCENT}>
              {stripVTControlCharacters(
                `${finding.severity} · ${finding.file}:${finding.line} · ${finding.title}`,
              )}
            </Text>
            <Text>{stripVTControlCharacters(finding.comment)}</Text>
            {finding.evidence ? (
              <Text color={DIM}>{stripVTControlCharacters(finding.evidence)}</Text>
            ) : null}
            {finding.suggestion ? (
              <Text>{stripVTControlCharacters(finding.suggestion)}</Text>
            ) : null}
          </Box>
        ) : null}
        <KeyHint
          keys={[
            ["↑↓", "browse findings"],
            ["esc", "back"],
          ]}
        />
      </Box>
    );
  }

  if (overlay === "repos") {
    return (
      <Box flexDirection="column">
        <Header subtitle="Auto-review settings" />
        <RepoPicker onDone={() => setOverlay("general")} />
      </Box>
    );
  }

  if (overlay === "viewReview" && viewPr != null) {
    return (
      <ReviewViewer
        forge={repo.forge}
        projectId={repo.projectId}
        prNumber={viewPr}
        onBack={() => setOverlay("none")}
      />
    );
  }

  if (
    overlay === "settings" ||
    overlay === "general" ||
    overlay === "tokenLimit" ||
    overlay === "confirmReset"
  ) {
    return (
      <SettingsOverlay
        view={overlay as SettingsView}
        model={model}
        passes={passes}
        tokenLimit={tokenLimit}
        onNavigate={(view) => setOverlay(view)}
        onCyclePasses={() => {
          // 1 → 2 → 3 → 1: extra passes re-scan with security/logic checklists
          const next = passes >= 3 ? 1 : passes + 1;
          updateConfig("reviewer", { passes: next });
          setPasses(next);
        }}
        onSetTokenLimit={(limit) => {
          updateConfig("reviewer", { token_limit: limit });
          setTokenLimit(limit);
        }}
        onQuit={() => {
          abortRef.current?.abort();
          exit();
        }}
        onConfirmReset={() => {
          abortRef.current?.abort();
          resetLogin();
          onReset();
        }}
      />
    );
  }

  // ---- main --------------------------------------------------------------------

  const forgeUser = creds[repo.forge]?.user;
  const counts = {
    open: openPrs ? String(openPrs.length) : "…",
    closed: closedPrs ? String(closedPrs.length) : "…",
  };

  const renderTab = (t: Tab, label: string) => (
    <Text bold={tab === t} color={tab === t ? ACCENT : DIM}>
      {tab === t ? "▸ " : "  "}
      {label} ({counts[t]})
    </Text>
  );

  return (
    <Box flexDirection="column">
      <Header />
      <Text color={DIM}>
        repo <Text color={ACCENT}>{repo.projectId}</Text> · {repo.forge}
        {forgeUser ? ` ✓ ${forgeUser}` : ""} · model <Text color={ACCENT}>{model}</Text>
      </Text>
      {endpoint ? <Text color={DIM}>review content sent to {endpoint.origin}</Text> : null}
      {watchTargets ? (
        <Text color={DIM}>
          <Text color={ACCENT}>
            <Spinner type="dots" />
          </Text>
          {" auto-posting reviews"}
          {` · every ${interval}s`}
        </Text>
      ) : null}

      <Box marginTop={1}>
        {renderTab("open", "Opened PRs")}
        <Text color={DIM}>{"   "}</Text>
        {renderTab("closed", "Closed PRs")}
        {refreshing ? (
          <Text color={DIM}>
            {"   "}
            <Spinner type="dots" /> refreshing…
          </Text>
        ) : null}
      </Box>

      <PrList
        list={list}
        tab={tab}
        activeIndex={activeIndex}
        statuses={statuses}
        listError={listError}
      />

      <Box flexDirection="column" marginTop={1}>
        <Text bold>Events</Text>
        {events.length === 0 ? (
          <Text color={DIM}>quiet…</Text>
        ) : (
          events.slice(-5).map((e, i) => (
            <Text key={i} color={e.includes("failed") ? "red" : DIM} wrap="truncate">
              {e}
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={1} borderStyle="round" borderColor={DIM} paddingX={1}>
        <KeyHint
          keys={[
            ["enter", tab === "open" ? "preview review" : "view review"],
            ...(tab === "open" ? ([["p", "post review"]] as [string, string][]) : []),
            ["a", watchTargets ? "stop auto-posting" : "authorize auto-posting"],
            ["v", "view review"],
            ["tab", "switch list"],
            ["R", "refresh"],
            ["r", "change repo"],
            ["s", "settings"],
          ]}
        />
      </Box>
    </Box>
  );
}
