// Assemble the dashboard API once for a browser window.
import { createProfile } from "./profile.mjs";
import { createRanking } from "./ranking.mjs";
import { createListings } from "./listings.mjs";
import { createBridge } from "./bridge.mjs";
import { createAccount } from "./account.mjs";

export function createCore(browser) {
  const {
    C, DAY, US_STATES, CA_PROVINCES, CANADA_KEYS, isCanadaKey, BASELINE, REGION_SHORTCUTS,
    YEARS, YEAR_LABEL, YEAR_PLURAL, STAGES, STAGE_LABEL, STAGE_DEFAULTS, upcomingTerms,
    TERMS, WORK_AUTH, fieldLabel, keyLabel, termText, ls, ss, PROFILE_KEY, emptyProfile,
    loadProfile, DELETED_KEY, saveProfile, profileDeleted, regs, shardKeys, profileKeys,
    ALL_KEY, viewScope, FIRST_KEYS, FILTER_PARAMS, filtersFromUrl, filterParams,
    filterSearch, loadPlan, demandStates, inCanadaOnly, isRemote, realSalary,
  } = createProfile(browser);
  const {
    parseQuery, splitPlaces, queryKeys, placeWords, stem, compileQuery, matchScore,
    applicationBatch, queuedListingIds, handledListingIds, heldUrls, SELECT_MAX,
    headerChecked, selectRows, sortRows, listRows, citizenRule, noSponsorship, payOf,
    citizenBlocked, yearsFit, yearsText, WEIGHTS, PART_LABEL, profileFields, primaryField,
    termFit, score,
  } = createRanking(browser, { US_STATES, CA_PROVINCES, CANADA_KEYS, isRemote, regs, fieldLabel, STAGE_LABEL, realSalary, YEAR_PLURAL, termText, shardKeys, DAY });
  const {
    createStore, majorForFields, loadMajors, majorsNote, loadStats,
  } = createListings(browser, { C, fieldLabel });
  const {
    ext, bridgeProfile, fromBridgeProfile,
  } = createBridge(browser, { emptyProfile });
  const {
    SESSION_KEY, workerOn, decodeJwt, authInfo, authOk, tokenOk, storedToken, startSession,
    handleRedirect, fetchWorkerConfig, PROVIDER_LABELS, count, startSignIn, signOut,
    postDemand, fetchMe, INVITE_KEY, INVITE_EDU_KEY, INVITE_TRIED_KEY, INVITE_CODE,
    INVITE_NUDGE_KEY, inviteNudgeDue, inviteNudgeSeen, markInviteNudge, DIGEST_NUDGE_KEY,
    createDigestNudge, fetchInvite, claimInvite, ALLOWANCE_LABELS, midSentence, PLAN_LABELS,
    PLANS_BANNER_KEY, PLANS_BANNER_ID, plansBanner, REVIEW_LINE_KEY, REVIEWS_URL,
    reviewLineDue, leftOf, allowanceText, billingUrl, deleteMyData, reportUrl, digestArchive,
  } = createAccount(browser, { C, ls, ss, DAY, demandStates, PROFILE_KEY, DELETED_KEY });

  return {
    C, DAY, US_STATES, CA_PROVINCES, CANADA_KEYS, isCanadaKey, inCanadaOnly, BASELINE, REGION_SHORTCUTS, YEARS, YEAR_LABEL, YEAR_PLURAL, STAGES, STAGE_LABEL, STAGE_DEFAULTS, TERMS, upcomingTerms, WORK_AUTH,
    fieldLabel, keyLabel, termText, ls, ss,
    emptyProfile, loadProfile, saveProfile, profileKeys, demandStates, ALL_KEY, viewScope, FIRST_KEYS, loadPlan,
    FILTER_PARAMS, filtersFromUrl, filterParams, filterSearch,
    parseQuery, splitPlaces, queryKeys, placeWords, stem, compileQuery, matchScore, majorForFields,
    regs, shardKeys, isRemote, realSalary, applicationBatch, queuedListingIds, handledListingIds, heldUrls, SELECT_MAX, headerChecked, selectRows, sortRows, listRows, citizenRule, noSponsorship, payOf, citizenBlocked, yearsFit, yearsText,
    // was: WEIGHTS, PART_LABEL, profileFields, score,
    // primaryField is exported because the dashboard's coverage line (docs/js/app.js) needs the
    // student's own tag, not the biggest one in the Set profileFields returns.
    WEIGHTS, PART_LABEL, profileFields, primaryField, score,
    // termFit (2026-10-14): the dashboard's season check that can only hide a listing from its own box.
    termFit,
    createStore, loadMajors, majorsNote, loadStats,
    ext, bridgeProfile, fromBridgeProfile,
    // was: workerOn, decodeJwt, tokenOk, storedToken, handleRedirect, fetchWorkerConfig, ...
    workerOn, decodeJwt, authInfo, authOk, tokenOk, storedToken, SESSION_KEY, handleRedirect, startSession, fetchWorkerConfig, startSignIn, count, PROVIDER_LABELS, signOut, postDemand, deleteMyData, profileDeleted,
    fetchMe, leftOf, allowanceText, plansBanner, PLANS_BANNER_KEY, PLANS_BANNER_ID, billingUrl, PLAN_LABELS, INVITE_KEY, INVITE_EDU_KEY, INVITE_TRIED_KEY, INVITE_CODE, fetchInvite, claimInvite, ALLOWANCE_LABELS, midSentence,
    INVITE_NUDGE_KEY, inviteNudgeDue, inviteNudgeSeen, markInviteNudge,
    DIGEST_NUDGE_KEY, createDigestNudge,
    REVIEW_LINE_KEY, REVIEWS_URL, reviewLineDue,
    reportUrl, digestArchive, sectorLabel: s => s ? String(s).replace(/_/g, " ").replace(/^./, c => c.toUpperCase()) : "",
  };
}
