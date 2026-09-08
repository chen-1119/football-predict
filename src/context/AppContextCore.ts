import { createContext, useContext } from 'react';
import type { Match } from '../services/mockData';
import type { AccessSession } from '../services/accessControl';
import type { ReviewPerformanceSummary } from '../services/reviewPerformanceTypes';

export type Language = 'zh' | 'en';
export type HitAndWinPick = '1' | 'X' | '2';
export type HitAndWinSubmission = Record<string, HitAndWinPick>;

export interface User {
  username: string;
}

export interface SourceFallbackCoverage {
  servingMode?: 'primary' | 'fallback-degraded' | 'critical' | 'unknown' | string;
  usable?: boolean;
  primaryStale?: boolean;
  currentMatches?: number;
  coveredByFiveHundredDetails?: number;
  fiveHundredCoverage?: number;
  fiveHundredCoveragePercent?: number;
  referenceOddsMatches?: number;
  referenceOddsCoverage?: number;
  referenceOddsCoveragePercent?: number;
  freshExternalSignals?: boolean;
  updatedAt?: string | null;
  detailsUpdatedAt?: string | null;
  fallbackReason?: string | null;
  currentLaneFresh?: boolean;
  relayCurrentFresh?: boolean;
  relayCurrentRows?: number;
  relayCurrentFreshnessTime?: string | null;
  resultLaneFresh?: boolean;
  resultLane?: {
    capturedAt?: string | null;
    latestCapturedAt?: string | null;
    ageMinutes?: number | null;
    maxAgeMinutes?: number | null;
    stale?: boolean;
    rows?: number;
    usableEndpoints?: number;
    methods?: string[];
  } | null;
  relayResultFresh?: boolean;
  relayResultRows?: number;
  relayResultFreshnessTime?: string | null;
  syncMetaCurrentStale?: boolean;
}

export interface HhadCompanionPublicEvaluation {
  version?: string | null;
  strategyVersion?: string | null;
  evaluatedAt?: string | null;
  onlineEffect?: 'shadow' | string;
  candidateReady?: boolean;
  candidateStatus?: string | null;
  promotionAllowed?: boolean;
  counts?: {
    snapshotRows?: number;
    trackRows?: number;
    currentStrategyRows?: number;
    finalRevisions?: number;
    finalEvaluate?: number;
    finalSkip?: number;
    exactReplayFinals?: number;
    nonExactReplayFinals?: number;
    missingOfficialResults?: number;
    resultConflicts?: number;
    settledWon?: number;
    settledLost?: number;
    settledVoid?: number;
    pairedNonVoidRows?: number;
    pairedMatchDays?: number;
    promotionTimeEligibleSettlements?: number;
    promotionTimeIneligibleSettlements?: number;
    ambiguousFinalRevisionGroups?: number;
    resultEventMismatches?: number;
    resultTimeRejected?: number;
  } | null;
  exactReplay?: {
    finals?: number;
    exact?: number;
    rate?: number | null;
    requiredRate?: number;
  } | null;
  pairedThreeWay?: {
    rows?: number;
    model?: { brier?: number | null; logLoss?: number | null } | null;
    deviggedMarket?: { brier?: number | null; logLoss?: number | null } | null;
    improvement?: { brier?: number | null; logLoss?: number | null } | null;
  } | null;
  descriptive?: {
    settled?: number;
    won?: number;
    lost?: number;
    hitRate?: number | null;
    profitUnits?: number | null;
    roi?: number | null;
    averageOdds?: number | null;
    gateUsage?: string;
  } | null;
  windows?: {
    type?: string | null;
    count?: number;
    improvingBothMetrics?: number;
    recentTwoNonNegative?: boolean;
    rows?: Array<{
      index?: number;
      startMatchDay?: string | null;
      endMatchDay?: string | null;
      matchDays?: number;
      rows?: number;
      improvement?: { brier?: number | null; logLoss?: number | null } | null;
    }>;
  } | null;
  bootstrap?: {
    method?: string | null;
    confidence?: number | null;
    percentileLowerProbability?: number | null;
    iterations?: number | null;
    matchDays?: number | null;
    rows?: number | null;
    lowerBounds?: { brierImprovement?: number | null; logLossImprovement?: number | null } | null;
  } | null;
  gate?: {
    version?: string | null;
    candidateReady?: boolean;
    thresholds?: {
      minimumPairedNonVoidRows?: number;
      windows?: number;
      minimumRowsPerWindow?: number;
      minimumImprovingWindows?: number;
      recentNonNegativeWindows?: number;
      minimumMatchDays?: number;
      bootstrapConfidence?: number;
      exactReplayRate?: number;
      requiredGlobalRiskTier?: string;
      onlineEffect?: string;
    } | null;
    failedChecks?: string[];
    interpretation?: string | null;
  } | null;
  policy?: {
    scoring?: string | null;
    descriptiveOnly?: string[];
    onlineEffect?: 'shadow' | string;
  } | null;
  publicView?: boolean;
  hiddenFields?: string[];
}

export interface DataSyncState {
  currentLoading?: boolean;
  currentLoaded: boolean;
  historyLoaded: boolean;
  historyLoading: boolean;
  currentCount: number;
  historyCount: number;
  totalCount: number;
  error?: string;
  updatedAt?: string;
  lastCheckedAt?: string;
  lastAttemptAt?: string;
  sourceUpdatedAt?: string;
  refreshIntervalSeconds?: number;
  backendRefreshMinutes?: number;
  byStatus?: Partial<Record<Match['status'], number>>;
  sourceAgeSeconds?: number | null;
  sourceStale?: boolean;
  serviceDataFresh?: boolean;
  sourceHealthOk?: boolean;
  sourceDataFresh?: boolean;
  fallbackDataFresh?: boolean;
  fallbackWithinReliableWindow?: boolean;
  fallbackAgeSeconds?: number | null;
  fallbackMaxAgeSeconds?: number | null;
  recommendationReliable?: boolean;
  healthServingMode?: string;
  healthCurrentReadSource?: string;
  syncTriggered?: boolean;
  dataApiSource?: string;
  dataChannel?: 'api' | 'static' | 'mock' | 'retained';
  retainedDataAt?: string;
  serviceTransitioning?: boolean;
  currentRefreshHealthy?: boolean;
  liveUpdates?: 'sse' | 'poll';
  lastServerEventAt?: string;
  lastServerEventType?: string;
  dataApiBase?: string;
  lastDataUrl?: string;
  apiFailureCount?: number;
  sourceAttempt?: {
    capturedAt?: string;
    transport?: string;
    relaySnapshotCapturedAt?: string | null;
    relaySnapshotStale?: boolean | null;
    relayCurrentLaneCapturedAt?: string | null;
    relayResultLaneCapturedAt?: string | null;
    relayResultLaneStale?: boolean;
    relayResultRows?: number;
    relayHistoryLaneCapturedAt?: string | null;
    relayHistoryLaneStale?: boolean;
    officialOddsMatches?: number;
    officialHandicapOddsMatches?: number;
    officialResultMatches?: number;
    publishableMatches?: number;
    fiveHundredFallbackMatches?: number;
    combinedPublishableMatches?: number;
    keptExisting?: boolean;
    mergedPartialFresh?: boolean;
    errors?: number;
  };
  sourceFallback?: {
    active?: boolean;
    servingMode?: string;
    usable?: boolean;
    primaryStale?: boolean;
    keptExisting?: boolean;
    mergedPartialFresh?: boolean;
    reason?: string;
    existingMatches?: number;
    freshPublishableMatches?: number;
    sportteryPublishableMatches?: number;
    fiveHundredFallbackMatches?: number;
    fiveHundredResultMatches?: number;
    referenceOddsMatches?: number;
    officialOddsMatches?: number;
    officialOddsCoverage?: number;
  };
  sourceHistoryGuard?: {
    active?: boolean;
    reason?: string | null;
    historyFreshnessTime?: string | null;
    historyAgeSeconds?: number | null;
  };
  sourceFallbackCoverage?: SourceFallbackCoverage;
  sourceHealthSummary?: {
    servingMode?: string;
    primaryStale?: boolean;
    usable?: boolean;
    currentLaneFresh?: boolean;
    resultLaneFresh?: boolean;
    resultStale?: boolean;
    relayResultFresh?: boolean;
    relayResultRows?: number;
    sourceFreshnessTime?: string | null;
    currentFreshnessTime?: string | null;
    resultFreshnessTime?: string | null;
    historyFreshnessTime?: string | null;
    sourceAgeSeconds?: number | null;
    currentAgeSeconds?: number | null;
    resultAgeSeconds?: number | null;
    historyAgeSeconds?: number | null;
    fallbackReason?: string | null;
  };
  modelHealth?: {
    evaluation?: {
      ok?: boolean;
      generatedAt?: string | null;
      version?: string | null;
      source?: string | null;
      coverageOk?: boolean;
      minCoverageRatio?: number;
      odds?: {
        modelRows?: number;
        sqliteRows?: number;
        minRows?: number;
        coverageRatio?: number | null;
        ok?: boolean;
      };
      predictionSnapshots?: {
        modelRows?: number;
        sqliteRows?: number;
        minRows?: number;
        coverageRatio?: number | null;
        ok?: boolean;
      };
      inputAuditOk?: boolean;
      riskTier?: string | null;
      probabilityRows?: number;
      marketBaselineRows?: number;
    };
  };
  modelEvaluation?: {
    ok?: boolean;
    apiVersion?: string;
    generatedAt?: string | null;
    publicScorecard?: {
      version?: string | null;
      generatedAt?: string | null;
      sample?: {
        matches?: number | null;
        probabilityRows?: number | null;
        marketBaselineRows?: number | null;
        predictionRows?: number | null;
        formalRecommendationRows?: number | null;
        clvRows?: number | null;
        clvCandidateRows?: number | null;
        clvTimingCoverage?: number | null;
        hhadCompanionPairedRows?: number | null;
      } | null;
      status?: {
        riskTier?: string | null;
        riskLabel?: {
          zh?: string;
          en?: string;
        } | null;
        onlineEffect?: string | null;
        promotionGateStatus?: string | null;
        inputAuditOk?: boolean | null;
        calibrationVersion?: string | null;
      } | null;
      marketComparison?: {
        rows?: number | null;
        currentModel?: {
          rows?: number | null;
          logLossImprovement?: number | null;
          brierImprovement?: number | null;
          accuracyDelta?: number | null;
        } | null;
        bestShadowCandidate?: {
          rows?: number | null;
          logLossImprovement?: number | null;
          brierImprovement?: number | null;
          accuracyDelta?: number | null;
          rollingPassRate?: number | null;
          rollingWindows?: number | null;
        } | null;
      } | null;
      formalPerformance?: {
        settled?: number;
        won?: number;
        lost?: number;
        hitRate?: number | null;
        flatStakeRoi?: number | null;
        avgOdds?: number | null;
        brier?: number | null;
        logLoss?: number | null;
      } | null;
      formalReviewPerformance?: ReviewPerformanceSummary | null;
      referenceReviewPerformance?: ReviewPerformanceSummary | null;
      hitRateAudit?: {
        version?: string;
        status?: 'collecting' | 'credible-near-target' | 'verified-below-target' | string;
        targetRate?: number;
        minimumSettledRows?: number;
        sampleReady?: boolean;
        observed?: {
          settled?: number;
          won?: number;
          lost?: number;
          hitRate?: number | null;
          interval95?: {
            lower?: number | null;
            upper?: number | null;
          } | null;
          flatStakeRoi?: number | null;
          avgOdds?: number | null;
          brier?: number | null;
          logLoss?: number | null;
        } | null;
        closingLineValue?: {
          version?: string | null;
          rows?: number;
          candidateRows?: number;
          timingCoverage?: number | null;
          positiveRate?: number | null;
          averageProbabilityMove?: number | null;
          timingAudit?: {
            version?: string | null;
            eligibleRows?: number;
            movementMissingRows?: number;
            reasonCounts?: Record<string, number>;
          } | null;
        } | null;
        externalBenchmark?: {
          claimedRate?: number;
          verificationStatus?: string;
          usableAsTrainingLabel?: boolean;
        } | null;
        denominatorPolicy?: string[];
        publicationPolicy?: {
          immutableLedgerRequired?: boolean;
          appendOnlySettlementRequired?: boolean;
          completeWinsAndLossesRequired?: boolean;
          postCutoffMutationForbidden?: boolean;
        } | null;
      } | null;
      shadowTracks?: {
        HHAD_COMPANION?: HhadCompanionPublicEvaluation | null;
        GOODWIN_BENCHMARK?: {
          version?: string | null;
          auditVersion?: string | null;
          role?: 'shadow-only' | string;
          status?: 'collecting' | 'promotion-review-ready' | string;
          activatedAt?: string | null;
          captureHeartbeat?: {
            version?: string | null;
            evaluatedAt?: string | null;
            fresh?: boolean;
            ok?: boolean;
            skipped?: boolean;
            reason?: string | null;
            dueMatches?: number;
            eventsAdded?: number;
            intervalSeconds?: number;
          } | null;
          targetHitRate?: number;
          criteria?: {
            marketType?: 'BEST' | string;
            oddsPoolCode?: 'HAD' | string;
            minimumEvidenceScore?: number;
            minimumOdds?: number;
            maximumOdds?: number;
            timeIntegrityAuditVersion?: string | null;
            earlyActualKickoffOrLiveObservationPolicy?: string | null;
          } | null;
          minimumSettledRowsForPromotionReview?: number;
          minimumChronologicalFolds?: number;
          minimumCalendarDays?: number;
          gates?: {
            thresholds?: {
              reviewCheckpoints?: number[];
              hitRateDisclosureOnly?: true;
              minimumRowsPerWindow?: number;
              maximumSingleWindowShare?: number;
              maximumAbsoluteSpiegelhalterZ?: number;
              minimumBrierSkillScore90LowerBound?: number;
              minimumPositiveClvRate?: number;
              minimumClosingLineCoverage?: number;
              minimumTimeIntegrityEvidenceCoverage?: number;
              minimumLeagueCount?: number;
              maximumSingleLeagueShare?: number;
              minimumRoiEvidenceRows?: number;
            } | null;
            checks?: Record<string, boolean>;
            evaluations?: Array<{
              checkpointN?: number;
              auditVersion?: string | null;
              evaluatedAt?: string | null;
              passed?: boolean;
              datasetHash?: string | null;
              rowHash?: string | null;
            }>;
            latestEvaluation?: {
              checkpointN?: number;
              auditVersion?: string | null;
              evaluatedAt?: string | null;
              passed?: boolean;
              datasetHash?: string | null;
              rowHash?: string | null;
            } | null;
          } | null;
          research?: {
            scope?: string | null;
            source?: string | null;
            snapshotVersion?: string | null;
            snapshotGeneratedAt?: string | null;
            snapshotRowsSha256?: string | null;
            selectedRows?: number;
            foldCount?: number;
            metrics?: {
              settled?: number;
              won?: number;
              lost?: number;
              hitRate?: number | null;
              confidence95Percent?: number[] | null;
              roiPercent?: number | null;
            } | null;
            promotionEligible?: false;
          } | null;
          prospective?: {
            ledgerVersion?: string | null;
            rootHash?: string | null;
            chainValid?: boolean;
            eventCount?: number;
            cohort?: {
              universe?: number;
              dueUniverse?: number;
              finalized?: number;
              selected?: number;
              excluded?: number;
              coverageGap?: number;
              identityConflicts?: number;
              dueWithoutDecision?: number;
              pending?: number;
              void?: number;
              settlementHolds?: number;
              settled?: number;
              won?: number;
              lost?: number;
            } | null;
            metrics?: {
              settled?: number;
              won?: number;
              lost?: number;
              hitRate?: number | null;
              confidence95Percent?: number[] | null;
              roiPercent?: number | null;
              averageOdds?: number | null;
              wilsonLowerBound?: number | null;
              modelBrier?: number | null;
              marketBrier?: number | null;
              brierSkillScore?: number | null;
              brierSkillScore90LowerBound?: number | null;
              expectedCalibrationError?: number | null;
              spiegelhalterZ?: number | null;
              absoluteSpiegelhalterZ?: number | null;
              closingLineRows?: number;
              closingLineCoverage?: number;
              medianClv?: number | null;
              positiveClvRows?: number;
              positiveClvRate?: number | null;
              timeIntegrityEvidenceRows?: number;
              timeIntegrityEvidenceCoverage?: number;
              spanDays?: number;
              leagueCount?: number;
              maximumSingleLeagueShare?: number | null;
              maximumSingleWindowShare?: number | null;
              roi95LowerPercent?: number | null;
            } | null;
            exclusionBlockers?: Record<string, number>;
          } | null;
          walkForward?: {
            protocol?: string | null;
            foldCount?: number;
            allFoldsStrictTimeOrder?: boolean;
            evaluationRows?: number;
            selectedRows?: number;
            coveragePercent?: number;
            metrics?: {
              settled?: number;
              won?: number;
              lost?: number;
              hitRate?: number | null;
              confidence95Percent?: number[] | null;
              roiPercent?: number | null;
              averageOdds?: number | null;
            } | null;
            baselineHitRate?: number | null;
            improvingFolds?: number;
          } | null;
          promotionReviewReady?: boolean;
          formalOnlineEffect?: boolean;
        } | null;
        CANDIDATE_PROSPECTIVE?: {
          version?: string | null;
          evaluatedAt?: string | null;
          state?: 'SHADOW' | 'ACTIVE' | 'PROMOTED' | 'RETIRED' | string;
          captureState?: {
            version: string;
            mode: 'shadow-observation';
            reason: string;
            candidateRevisionId: string;
            rootHash: string;
            evaluatedAt: string;
            frozenAt: string;
            formalTrialActive: false;
            formalRecommendationAllowed: false;
            onlineEffect: false;
          } | null;
          onlineEffect?: false;
          baseCandidateId?: string | null;
          candidateRevisionId?: string | null;
          frozenAt?: string | null;
          activationAt?: string | null;
          chainValid?: boolean;
          rootHash?: string | null;
          headerHash?: string | null;
          gateSpecHash?: string | null;
          inventoryHashAtFreeze?: string | null;
          totalCandidatesEverTested?: number;
          captureHeartbeat?: {
            version?: string | null;
            evaluatedAt?: string | null;
            fresh?: boolean;
            ok?: boolean;
            skipped?: boolean;
            reason?: string | null;
            dueMatches?: number;
            eventsAdded?: number;
            intervalSeconds?: number;
            readiness?: {
              version?: string | null;
              upcomingMatches?: number;
              readyNow?: number;
              awaitingMarket?: number;
              blocked?: number;
              readinessRatio?: number | null;
              nearestDeadlineAt?: string | null;
              nearestStatus?: string | null;
              blockerCounts?: Record<string, number>;
              admission?: {
                version?: string | null;
                registryAvailable?: boolean;
                expectedRows?: number;
                auditedRows?: number;
                admitted?: number;
                excluded?: number;
                pendingDeadline?: number;
                dueUnrecorded?: number;
                readyAlreadyAdmitted?: number;
                readyPendingDeadline?: number;
                readyDueUnrecorded?: number;
                unreconciled?: number;
                captureGap?: boolean;
                reconciled?: boolean;
              } | null;
            } | null;
          } | null;
          cohort?: {
            shadow?: {
              universe?: number;
              admitted?: number;
              excluded?: number;
              pending?: number;
              settled?: number;
              invalid?: number;
            } | null;
            formal?: {
              universe?: number;
              admitted?: number;
              excluded?: number;
              pending?: number;
              settled?: number;
              invalid?: number;
              finalized?: number;
              denominatorReconciled?: boolean;
            } | null;
          } | null;
          metrics?: {
            formalRows?: number;
            logLossImprovement?: number | null;
            brierImprovement?: number | null;
            invalidShare?: number | null;
            singleAttestorShare?: number | null;
            adjustedLogLossLowerBound?: number | null;
            adjustedBrierLowerBound?: number | null;
            calendarWindows?: number;
            registeredCalendarWindows?: number;
            winningCalendarWindows?: number;
            requiredWinningCalendarWindows?: number;
            calendarWindowGatePassed?: boolean;
          } | null;
          promotionReviewReady?: boolean;
          formalPromotionEligible?: boolean;
          blockers?: string[];
          policy?: string | null;
        } | null;
      } | null;
      buckets?: {
        scope?: 'formal-recommendations-only' | string;
        markets?: Array<{
          id?: string;
          label?: { zh?: string; en?: string };
          tier?: string;
          metrics?: {
            settled?: number;
            won?: number;
            lost?: number;
            hitRate?: number | null;
            flatStakeRoi?: number | null;
            avgOdds?: number | null;
          } | null;
        }>;
        leagues?: Array<{
          id?: string;
          label?: { zh?: string; en?: string };
          tier?: string;
          metrics?: {
            settled?: number;
            hitRate?: number | null;
            avgOdds?: number | null;
          } | null;
        }>;
        competitionGroups?: Array<{
          id?: string;
          label?: { zh?: string; en?: string };
          tier?: string;
          metrics?: {
            settled?: number;
            hitRate?: number | null;
            avgOdds?: number | null;
          } | null;
        }>;
        odds?: Array<{
          id?: string;
          label?: { zh?: string; en?: string };
          tier?: string;
          metrics?: {
            settled?: number;
            hitRate?: number | null;
            avgOdds?: number | null;
          } | null;
        }>;
        confidence?: Array<{
          id?: string;
          tier?: string;
          rows?: number;
          avgConfidence?: number | null;
          hitRate?: number | null;
          calibrationError?: number | null;
        }>;
      } | null;
      notes?: Array<{
        code?: string;
        zh?: string;
        en?: string;
      }>;
      publicView?: boolean;
      hiddenFields?: string[];
    } | null;
    backtest?: {
      version?: string | null;
      generatedAt?: string | null;
      sample?: {
        matches?: number | null;
        probabilityRows?: number;
        marketBaselineRows?: number;
        predictionSnapshots?: number;
        oddsHistoryRows?: number | null;
        clvRows?: number | null;
        clvCandidateRows?: number | null;
        clvTimingCoverage?: number | null;
        hhadCompanion?: HhadCompanionPublicEvaluation['counts'] | null;
        hhadCompanionTrackRows?: number | null;
        hhadCompanionPairedRows?: number | null;
        historicalModelRows?: {
          elo?: number | null;
          poisson?: number | null;
          historicalBlend?: number | null;
          [key: string]: number | null | undefined;
        } | null;
      } | null;
      inputAudit?: {
        version?: string | null;
        ok?: boolean | null;
        violationCount?: number | null;
        coverage?: {
          rows?: number;
          rowsWithForecastTime?: number;
          rowsWithMarketAtForecast?: number;
          rowsWithClosingLine?: number;
          rowsWithHistoricalFeatureSnapshot?: number;
        } | null;
        timeWindow?: {
          firstKickoffTime?: string | null;
          lastKickoffTime?: string | null;
          firstForecastTime?: string | null;
          lastForecastTime?: string | null;
        } | null;
      } | null;
      closingLineValue?: {
        version?: string | null;
        rows?: number;
        candidateRows?: number;
        timingCoverage?: number | null;
        positiveClvRate?: number | null;
        avgProbabilityMove?: number | null;
        avgOddsRatioMove?: number | null;
        directionCounts?: {
          positive?: number;
          flat?: number;
          negative?: number;
        } | null;
        timingAudit?: {
          version?: string | null;
          candidateRows?: number;
          eligibleRows?: number;
          movementMissingRows?: number;
          reasonCounts?: Record<string, number>;
          policy?: string;
        } | null;
      } | null;
      shadowCandidates?: {
        version?: string;
        bestCandidateId?: string;
        sample?: {
          rows?: number;
        };
      } | null;
      hhadCompanionEvaluation?: HhadCompanionPublicEvaluation | null;
      riskTiers?: {
        version?: string | null;
        generatedAt?: string | null;
        overall?: {
          tier?: 'stable' | 'watch' | 'degraded' | string;
          label?: {
            zh?: string;
            en?: string;
          };
          score?: number;
          reasons?: Array<{
            code?: string;
            tier?: string;
            message?: string;
            evidence?: Record<string, unknown>;
          }>;
        } | null;
        confidenceBuckets?: {
          rows?: number;
          bucketCount?: number;
          maxCalibrationError?: number | null;
          weightedCalibrationError?: number | null;
          buckets?: Array<{
            id?: string;
            tier?: string;
            rows?: number;
            avgConfidence?: number | null;
            hitRate?: number | null;
            calibrationError?: number | null;
            reasons?: string[];
          }>;
        } | null;
        recommendationBuckets?: Array<{
          id?: string;
          scope?: 'formal' | string;
          tier?: string;
          settled?: number;
          hitRate?: number | null;
          flatStakeRoi?: number | null;
          avgOdds?: number | null;
          reasons?: string[];
        }>;
        recommendationBucketScope?: 'formal' | string;
        shadowRecommendationBucketScope?: 'shadow' | string;
        shadowRecommendationBuckets?: Array<{
          id?: string;
          scope?: 'shadow' | string;
          tier?: string;
          settled?: number;
          hitRate?: number | null;
          flatStakeRoi?: number | null;
          avgOdds?: number | null;
          reasons?: string[];
        }>;
        marketComparison?: {
          rows?: number;
          bestShadowCandidate?: {
            id?: string | null;
            rollingPassRate?: number | null;
          } | null;
        } | null;
        policy?: {
          onlineEffect?: string;
          probabilityOverride?: boolean;
          llmBoundary?: string;
        };
      } | null;
      policy?: {
        promotionGate?: string;
        llmRole?: string;
      } | null;
    } | null;
    calibration?: {
      version?: string | null;
    } | null;
    strategy?: {
      version?: string | null;
      generatedAt?: string | null;
      activation?: {
        mode?: string;
        onlineEffect?: string;
        riskGuard?: {
          riskTier?: string | null;
          looseningAllowed?: boolean | null;
          tighteningAllowed?: boolean | null;
          policy?: string | null;
        };
        promotionGate?: {
          status?: string;
          eligibleScope?: string;
          reasons?: string[];
          sample?: {
            marketBaselineRows?: number;
            probabilityRows?: number;
            shadowCandidateRows?: number;
            candidateRows?: number;
            modelCandidateRows?: number;
          };
          thresholds?: {
            minMarketBaselineRows?: number;
          };
          metrics?: {
            logLossImprovement?: number | null;
            brierImprovement?: number | null;
            accuracyDelta?: number | null;
            rollingPassRate?: number | null;
            currentModelLogLossImprovement?: number | null;
            currentModelBrierImprovement?: number | null;
            bestModelLogLossImprovement?: number | null;
            bestModelBrierImprovement?: number | null;
            bestModelRollingPassRate?: number | null;
          };
          modelSignal?: {
            status?: string | null;
            onlineEffect?: string | null;
            readyForGuardedUse?: boolean | null;
            bestCandidateUsesModelSignal?: boolean | null;
            bestModelCandidateId?: string | null;
            rollingSource?: string | null;
            policy?: string | null;
          };
          modelSignalCandidate?: {
            id?: string | null;
            comparison?: {
              rows?: number | null;
              logLossImprovement?: number | null;
              brierImprovement?: number | null;
              accuracyDelta?: number | null;
            } | null;
          } | null;
        };
      };
    } | null;
    policy?: {
      baselineRequired?: string;
      splitPolicy?: string;
      llmRole?: string;
      sourceCutover?: string;
    };
    probabilityArchitecture?: {
      version?: string | null;
      outputs?: Array<{
        id?: string;
        label?: string;
        public?: boolean;
      }>;
      layers?: Array<{
        id?: string;
        role?: string;
        status?: string | null;
        rows?: number | null;
        note?: string;
      }>;
      sample?: {
        matches?: number | null;
        probabilityRows?: number | null;
        marketBaselineRows?: number | null;
        historicalModelRows?: {
          elo?: number | null;
          poisson?: number | null;
          historicalBlend?: number | null;
          [key: string]: number | null | undefined;
        } | null;
        rollingWindows?: number | null;
      };
      comparison?: {
        currentModelLogLossImprovement?: number | null;
        currentModelBrierImprovement?: number | null;
        bestShadowLogLossImprovement?: number | null;
        bestShadowBrierImprovement?: number | null;
        rollingPassRate?: number | null;
      };
      calibration?: {
        version?: string | null;
        scoreCalibrationVersion?: string | null;
        riskTier?: string | null;
        maxCalibrationError?: number | null;
      };
      gates?: {
        splitPolicy?: string;
        leakageGuard?: string;
        promotionMetric?: string[];
        baselineRequired?: boolean;
        probabilityOverride?: boolean;
        llmBoundary?: string;
      };
      publicView?: boolean;
      hiddenFields?: string[];
    };
    sourcePolicy?: {
      version?: string;
      primary?: string;
      supplemental?: string[];
      fullFiveHundredCutover?: {
        allowed?: boolean;
        reason?: string;
        minimumCurrentCoverage?: number;
        maxDetailsErrors?: number;
        requireStableMatchIdentity?: boolean;
        requireOfficialCutoffSemantics?: boolean;
      };
      runtimeRule?: {
        keepLastTrustedPrimary?: boolean;
        doNotPublishEmptyCurrentSlate?: boolean;
        markStaleWhenPrimaryLate?: boolean;
        useFiveHundredWhenMappedAndFresh?: boolean;
      };
      publicView?: boolean;
    };
  };
  sourceHealth?: {
    ok?: boolean;
    checkedAt?: string;
    mode?: {
      enable500Sync?: boolean;
      enable500DetailsSync?: boolean;
      enableWeatherSync?: boolean;
      enableApiFootballSync?: boolean;
      enablePreMatchSignalsSync?: boolean;
      requireExternalSignals?: boolean;
      skipSportteryFetch?: boolean;
    };
    sources?: Array<{
      id?: string;
      label?: string;
      role?: string;
      enabled?: boolean;
      required?: boolean;
      status?: string;
      score?: number;
      updatedAt?: string | null;
      ageMinutes?: number | null;
      maxAgeMinutes?: number | null;
      stale?: boolean;
      metrics?: Record<string, unknown>;
    }>;
    sourceScores?: Record<string, {
      status?: string;
      score?: number;
      stale?: boolean;
      updatedAt?: string | null;
      ageMinutes?: number | null;
    }>;
    sportteryEgress?: {
      exists?: boolean;
      ok?: boolean | null;
      status?: string;
      checkedAt?: string | null;
      transport?: string | null;
      proxyConfigured?: boolean;
      summary?: {
        endpoints?: number;
        jsonEndpoints?: number;
        rows?: number;
        wafBlocked?: boolean;
        htmlResponses?: number;
        http403?: number;
      } | null;
      guidance?: string[];
    };
    sportteryRelaySnapshot?: {
      capturedAt?: string | null;
      ageMinutes?: number | null;
      maxAgeMinutes?: number | null;
      stale?: boolean;
      rows?: number;
      usableEndpoints?: number;
      methods?: string[];
      resultLane?: SourceFallbackCoverage['resultLane'];
    } | null;
    externalSignals?: {
      fiveHundredRows?: number;
      fiveHundredMapped?: number;
      fiveHundredDetailsCachedMerged?: number;
      fiveHundredDetailsErrors?: number;
      apiFootballConfigured?: boolean;
      apiFootballEnabled?: boolean;
      apiFootballMappedSignals?: number;
      apiFootballCallsThisSync?: number;
      apiFootballCallsTodayEstimate?: number;
    };
    preMatchSignals?: {
      exists?: boolean;
      updatedAt?: string | null;
      ageMinutes?: number | null;
      matchKeys?: number;
      high?: number;
      medium?: number;
      low?: number;
      warningCount?: number;
    };
    currentMatches?: {
      count?: number;
      withExternalSignals?: number;
      externalCoverage?: number;
      withSportteryOdds?: number;
      withReferenceOdds?: number;
      withFiveHundredDetails?: number;
      withWeather?: number;
      withPreMatchSignals?: number;
    };
      fallbackCoverage?: SourceFallbackCoverage;
      warnings?: string[];
      errors?: string[];
  };
}

export interface AppContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  currentUser: User | null;
  setCurrentUser: (user: User | null) => void;
  accessSession: AccessSession | null;
  isAccessVerified: boolean;
  hitAndWinSubmission: HitAndWinSubmission | null;
  submitHitAndWin: (selections: HitAndWinSubmission) => boolean;
  verifyAccessCode: (code: string) => Promise<AccessSession>;
  clearAccessSession: () => void;
  login: (username: string) => void;
  register: (username: string) => void;
  logout: () => void;
  matches: Match[];
  dataSync: DataSyncState;
}

export const AppContext = createContext<AppContextType | undefined>(undefined);

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
