// Assemble the dashboard for one browser window and React instance.
import { createAllowance } from "./allowance.mjs";
import { createTracker } from "./tracker.mjs";
import { createPresentation } from "./presentation.mjs";
import { createExtension } from "./extension.mjs";
import { createControls } from "./controls.mjs";
import { createRows } from "./rows.mjs";
import { createNavigation } from "./navigation.mjs";
import { createSetup } from "./setup.mjs";
import { createDashboardFollow } from "./follow.mjs";
import { createDashboard } from "./dashboard.mjs";

export function createApp(browser) {
  const { useState, useEffect, useMemo, useRef, useCallback, useId, useLayoutEffect = useEffect } = browser.React;
  const h = browser.React.createElement, F = browser.React.Fragment;
  const IS = browser.IS, C = IS.C;
  const ADMIN = new browser.URLSearchParams(browser.location.search).get("admin") === "1";
  // "Don't count this browser" (js/count.js), switched from the admin menu.
  const NOCOUNT_KEY = "internscout.nocount";
  const noCount = () => { try { return browser.localStorage.getItem(NOCOUNT_KEY) === "1"; } catch (e) { return false; } };

  const EXT_NOTICE_KEY = "internscout.extnotice.v1";
  // The one-time notice that paid listings have started (S8, 2026-10-14): hidden for good in this browser.
  const PLACE_NOTICE_KEY = "internscout.placements.notice.v1";

  const {
    arrivalFlag, configuredPlans, allowanceArrival, clearArrivalKeys, runAllowance, bounded,
    bonusWords, countArrivalOnce, focusArrival, visibleFocusAnchor, restoreArrivalAnchor,
    validInvite, InviteBlock, AllowancePanel,
  } = createAllowance(browser, {
    IS, h, F,
  });

  const {
    LS_KEY, SAVED_KEY, LANDING_KEY, SKIP_KEY, MORE_KEY, APP_STATES, MYLIST_KEY, VISIT_KEY,
    publicRole, readMyList, writeLocal, savedRoleRows, sinceVisit, resolveSavedRoles,
  } = createTracker(browser, {
    IS,
  });

  const {
    STATE_LABEL, JOB_LABEL, ATS, SUPPORTED_ATS, ACTIVE, PAGE, DESC_AUTO, daysAgo, ago, fmtDay,
    daysUntil, postedTime, plural, cx, prevent, scrollBehavior, touchOnly, installUrl,
  } = createPresentation(browser, {
    IS, h, C,
  });

  const {
    checks, blockers, useExtension,
  } = createExtension(browser, {
    IS, daysUntil, fmtDay, plural, useState, useCallback, useEffect,
  });

  const {
    MultiSelect, AccountMenu, Sel, opt,
  } = createControls(browser, {
    useState, useRef, useId, useEffect, useMemo, h, cx,
  });

  const {
    CompanyTile, compactLocation, Loc, Why, factsLine, matchControl, Row, SearchBox,
    companyRuns, ListTable,
  } = createRows(browser, {
    h, IS, useRef, useEffect, useMemo, daysAgo, checks, F, cx, ATS, postedTime, ago, useState,
    SUPPORTED_ATS, ACTIVE, daysUntil, fmtDay, blockers, APP_STATES, opt, STATE_LABEL,
    JOB_LABEL, installUrl, PAGE,
  });

  const {
    PlaceNotice, useNarrow, SiteNav, Landing, Digest,
  } = createNavigation(browser, {
    h, useMemo, useState, useEffect, useRef, installUrl, IS, prevent,
  });

  const {
    quickProfile, QuickProfile, Setup, ShareSearch,
  } = createSetup(browser, {
    IS, useMemo, h, MultiSelect, Sel, opt, useState, useRef, useEffect, scrollBehavior, cx, F,
  });

  const DashboardFollow = createDashboardFollow(browser);

  const App = createDashboard(browser, {
    useRef, IS, useState, SKIP_KEY, LANDING_KEY, LS_KEY, SAVED_KEY, PAGE, readMyList,
    MYLIST_KEY, VISIT_KEY, useCallback, writeLocal, useEffect, bounded, useExtension, useMemo,
    resolveSavedRoles, DESC_AUTO, arrivalFlag, runAllowance, countArrivalOnce,
    allowanceArrival, EXT_NOTICE_KEY, clearArrivalKeys, bonusWords, validInvite,
    scrollBehavior, quickProfile, publicRole, MORE_KEY, blockers, savedRoleRows, companyRuns,
    touchOnly, plural, C, h, cx, configuredPlans, visibleFocusAnchor, useLayoutEffect,
    restoreArrivalAnchor, focusArrival, Setup, QuickProfile, STATE_LABEL, useNarrow, factsLine,
    matchControl, Why, prevent, PLACE_NOTICE_KEY, PlaceNotice, F, installUrl, SiteNav, ADMIN,
    AccountMenu, noCount, NOCOUNT_KEY, AllowancePanel, InviteBlock, Sel, opt, APP_STATES,
    SearchBox, MultiSelect, ShareSearch, ListTable, Digest, Row, sinceVisit, Landing, DashboardFollow,
  });

  return {
    App,
    arrivalFlag, configuredPlans, allowanceArrival, clearArrivalKeys, runAllowance,
    validInvite, bounded, countArrivalOnce, focusArrival, visibleFocusAnchor,
    restoreArrivalAnchor, InviteBlock, AllowancePanel, ListTable, MultiSelect, Setup, Row, Why,
    Digest, SiteNav, factsLine, matchControl, companyRuns, PlaceNotice, quickProfile,
    QuickProfile, Sel, readMyList, publicRole, writeLocal, savedRoleRows, sinceVisit,
    resolveSavedRoles, SearchBox, Loc, compactLocation, postedTime, CompanyTile,
  };
}
