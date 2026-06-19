import React from 'react';

type ReplayWithSavedPath = {
  savedPath?: string;
};

type SavedReplaySummaryLike = {
  path: string;
  fixture: { id: string };
  provider: { id: string };
};

export function useReplayArtifacts<
  Fixture extends { id: string },
  Mode extends string,
  Replay extends ReplayWithSavedPath,
  Artifact,
  SavedReplay extends SavedReplaySummaryLike,
  PromoteResult,
  PromotedFixture,
>({
  buildArtifact,
  fixture,
  loadPromotedFixtures,
  loadSavedReplays,
  mode,
  model,
  promoteReplay,
  replay,
  resetToken,
  saveArtifact,
  setReplay,
}: {
  buildArtifact: (fixture: Fixture, replay: Replay, mode: Mode, model: string) => Artifact;
  fixture: Fixture;
  loadPromotedFixtures: () => Promise<PromotedFixture[]>;
  loadSavedReplays: () => Promise<SavedReplay[]>;
  mode: Mode;
  model: string;
  promoteReplay: (path: string) => Promise<PromoteResult>;
  replay: Replay | null;
  resetToken: number;
  saveArtifact: (artifact: Artifact) => Promise<string>;
  setReplay: React.Dispatch<React.SetStateAction<Replay | null>>;
}) {
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [savedReplays, setSavedReplays] = React.useState<SavedReplay[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [selectedReviewPath, setSelectedReviewPath] = React.useState<string | null>(null);
  const [promotingPath, setPromotingPath] = React.useState<string | null>(null);
  const [promoteResult, setPromoteResult] = React.useState<PromoteResult | null>(null);
  const [promotedFixtures, setPromotedFixtures] = React.useState<PromotedFixture[]>([]);
  const [promotedLoading, setPromotedLoading] = React.useState(false);
  const [promotedError, setPromotedError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setSaveError(null);
    setPromoteResult(null);
  }, [resetToken]);

  const refreshReplayHistory = React.useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      setSavedReplays(await loadSavedReplays());
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setHistoryLoading(false);
    }
  }, [loadSavedReplays]);

  React.useEffect(() => {
    void refreshReplayHistory();
  }, [refreshReplayHistory]);

  const refreshPromotedFixtures = React.useCallback(async () => {
    setPromotedLoading(true);
    setPromotedError(null);
    try {
      setPromotedFixtures(await loadPromotedFixtures());
    } catch (caught) {
      setPromotedError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPromotedLoading(false);
    }
  }, [loadPromotedFixtures]);

  React.useEffect(() => {
    void refreshPromotedFixtures();
  }, [refreshPromotedFixtures]);

  const saveCurrentReplay = React.useCallback(async () => {
    if (!replay) return;
    setSaving(true);
    setSaveError(null);
    try {
      const artifact = buildArtifact(fixture, replay, mode, model);
      const savedPath = await saveArtifact(artifact);
      setReplay((current) => current ? { ...current, savedPath } : current);
      setSelectedReviewPath(savedPath);
      await refreshReplayHistory();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }, [buildArtifact, fixture, mode, model, refreshReplayHistory, replay, saveArtifact, setReplay]);

  const promoteSavedReplay = React.useCallback(async (path: string) => {
    setPromotingPath(path);
    setHistoryError(null);
    setPromoteResult(null);
    try {
      const result = await promoteReplay(path);
      setPromoteResult(result);
      await refreshPromotedFixtures();
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPromotingPath(null);
    }
  }, [promoteReplay, refreshPromotedFixtures]);

  const latestReviewPath = replay?.savedPath
    ?? selectedReviewPath
    ?? savedReplays.find((savedReplay) => savedReplay.fixture.id === fixture.id && savedReplay.provider.id === mode)?.path;

  return {
    historyError,
    historyLoading,
    latestReviewPath,
    promotedError,
    promotedFixtures,
    promotedLoading,
    promoteResult,
    promoteSavedReplay,
    promotingPath,
    refreshPromotedFixtures,
    refreshReplayHistory,
    saveCurrentReplay,
    saveError,
    savedReplays,
    saving,
    selectedReviewPath,
    setHistoryError,
    setPromoteResult,
    setSaveError,
    setSelectedReviewPath,
  };
}
