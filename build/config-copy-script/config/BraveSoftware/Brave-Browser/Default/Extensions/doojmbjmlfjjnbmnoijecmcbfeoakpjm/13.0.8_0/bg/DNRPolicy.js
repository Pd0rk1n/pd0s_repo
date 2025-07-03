/*
 * NoScript - a Firefox extension for whitelist driven safe JavaScript execution
 *
 * Copyright (C) 2005-2024 Giorgio Maone <https://maone.net>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

// depends on /nscl/service/NavCache.js

'use strict';
{
  const DEFAULT_PRIORITY = 1;
  const SITE_PRIORITY = 10;
  const CASCADE_PRIORITY = 20;
  const CTX_PRIORITY = 30;
  const TAB_PRIORITY = 40;
  const REPORT_PRIORITY = 50;
  const MAX_PRIORITY = 100;

  const SESSION_BASE = 100;
  const TAB_BASE = 10000;
  const DYNAMIC_BASE = 20000;

  let _lastPolicy;

  const dnrTypes = Object.values(browser.declarativeNetRequest.ResourceType);
  const resourceTypesMap = {};
  for(const [key, value] of Object.entries(RequestGuard.policyTypesMap)) {
    if (!(value && dnrTypes.includes(key))) continue;
    const mapping = resourceTypesMap[value] ||= [];
    mapping.push(key);
  }

  const ResourceTypeFor = {
    block(caps) {
      return this.allow(Permissions.ALL.filter(cap => !caps.has(cap)));
    },
    allow(caps) {
      const resourceTypes = [];
      for (let c of [...caps]) {
        if (c in resourceTypesMap) {
          resourceTypes.push(...resourceTypesMap[c]);
        }
      }
      return resourceTypes;
    }
  }

  function forBlockAllow(capabilities, callback) {
   for (const actionType of ["block", "allow"]) {
      const resourceTypes = ResourceTypeFor[actionType](capabilities);
      if (resourceTypes?.length) {
        callback(actionType, resourceTypes);
      }
   }
  }

  function toUrlFilter(siteKey) {
    // Note: using '^' instead of '/' as a terminator
    // takes explicit port numbers in account
    if (Sites.isSecureDomainKey(siteKey)) {
      return `||${Sites.toggleSecureDomainKey(siteKey,false)}^`
    }
    const schemeLess = siteKey.replace(/^[\w-]+:\/+/, "");
    let urlFilter = `${siteKey == schemeLess ? "||" : "|"}${siteKey}`;
    if (!schemeLess.includes('/')) {
      urlFilter += '^';
    }
    return urlFilter;
  }

  const reportedCaps = ['script', 'object', 'media', 'frame', 'font'];
  const reportingCSP = `${reportedCaps
      .map(cap => `${cap}-src 'none'`)
      .join(';')
    }; script-src-elem 'none'; report-to noscript-reports-dnr`; // see /content/content.js securitypolicyviolation handler

  browser.runtime.onStartup.addListener(async () => {
    const updatedTabs = autoAllow(await browser.tabs.query({}), true);

    if (updatedTabs.length) {
      await Promise.allSettled([
        ns.saveSession(),
        RequestGuard.DNRPolicy.update(),
      ]);
      for (const tab of updatedTabs) {
        if (tab.status != "unloaded") {
          browser.tabs.reload(tab.id);
        }
      }
    }
  });

  async function update() {
    const {policy} = ns;
    if (!policy || policy == _lastPolicy || _lastPolicy?.equals(policy)) {
      return await updateTabs();
    }
    _lastPolicy = policy;

    const Rules = {
      // Using capitalized keys to allow DRY tricks with get/update methods
      Session: [],
      Dynamic: [{
        id: 1,
        priority: REPORT_PRIORITY,
        action: {
          type: "modifyHeaders",
          responseHeaders: [{
            header: "content-security-policy-report-only",
            operation: "set",
            value: reportingCSP,
          }],
        },
        condition: {
          resourceTypes: ["main_frame", "sub_frame"],
        },
      }],
      lastId: 1,
      add({capabilities, temp}, priority = SITE_PRIORITY, siteKey) {
        const urlFilter = siteKey ? toUrlFilter(siteKey) : undefined;
        forBlockAllow(capabilities, (type, resourceTypes) => {
          const rules = temp ? this.Session : this.Dynamic;
          const id = (temp ? SESSION_BASE : DYNAMIC_BASE) + rules.length;
          rules.push({
            id,
            priority,
            action: {
              type,
            },
            condition: {
              urlFilter,
              resourceTypes,
            }
          });
        });
      }
    };

    if (policy?.enforced) {
      Rules.add(policy.DEFAULT, DEFAULT_PRIORITY);
      for (const [siteKey, perms] of [...policy.sites]) {
        Rules.add(perms, SITE_PRIORITY, siteKey);
      }
    }

    await addTabRules(Rules.Session);


    await Promise.allSettled(["Dynamic", "Session"].map((async (ruleType) => {

      const removeRuleIds = (
        await browser.declarativeNetRequest[`get${ruleType}Rules`]()
      ).filter(r => r.priority <= MAX_PRIORITY).map(r => r.id);
      try {
        await browser.declarativeNetRequest[`update${ruleType}Rules`]({
          addRules: Rules[ruleType],
          removeRuleIds,
        });


      } catch (e) {
        console.error(e, `Failed to update DNRPolicy ${ruleType}rules %o - remove %o, add %o`, Rules[ruleType], addRules, removeRuleIds);
      }
    })));

  }

  async function addTabRules(rules = []) {
    if (ns.unrestrictedTabs.size) {
      const tabIds = [...ns.unrestrictedTabs];
      tabIds.push(browser.tabs.TAB_ID_NONE); // for service workers
      rules.push({
        id: TAB_BASE,
        priority: TAB_PRIORITY,
        action: {
          type: "allowAllRequests",
        },
        condition: {
          tabIds,
          resourceTypes: ["main_frame", "sub_frame"],
        }
      });
      rules.push({
        id: TAB_BASE + 1,
        priority: TAB_PRIORITY,
        action: {
          type: "allow",
        },
        condition: {
          tabIds,
          resourceTypes: dnrTypes,
        }
      });
    }
    await addCtxRules(rules);
    return rules;
  }

  async function addCtxRules(rules) {

    const {policy} = ns;
    const cascade = ns.sync.cascadeRestrictions;
    const ctxSettings = [...policy.sites].filter(([siteKey, perms]) => perms.contextual?.size);
    const tabs = (ctxSettings.length || cascade) &&
      TabCache.getAll().filter(tab => tab.url && !ns.unrestrictedTabs.has(tab.id));
    if (!tabs?.length) {
      return rules;
    }
    await NavCache.awakening;
    for (const tab of tabs) {
      tab.topUrls = NavCache.getTab(tab.id)?.topUrls || [tab.url];
    }
    for (const [siteKey,] of ctxSettings) {

      const ctxTabs = [];
      for (const tab of tabs) {
        for (const url of tab.topUrls) {
          const settings = policy.get(siteKey, url);
          if (!settings.contextMatch) continue;
          ctxTabs.push({
            id: tab.id,
            settings,
            domain: url != tab.url && tld.getDomain(new URL(url).hostname),
          });
        }
      }
      const caps2Tabs = new Map();
      for(const {id, settings, domain} of ctxTabs) {
        const capsKey = JSON.stringify({
          initiatorDomains: domain ? [domain] : undefined,
          capabilities: [...settings.perms.capabilities]
        });
        caps2Tabs.get(capsKey)?.push(id) || caps2Tabs.set(capsKey, [id]);
      }
      const urlFilter = toUrlFilter(siteKey);
      for (const [capsKey, tabIds] of [...caps2Tabs]) {
        const { initiatorDomains, capabilities } = JSON.parse(capsKey);
        forBlockAllow(new Set(capabilities), (type, resourceTypes) => {
          if (type == "allow" && resourceTypes.includes("script")) {
            tabIds.push(browser.tabs.TAB_ID_NONE); // for service workers
          }
          rules.push({
            id: TAB_BASE + rules.length,
            priority: CTX_PRIORITY,
            action: {
              type,
            },
            condition: {
              tabIds,
              urlFilter,
              resourceTypes,
              initiatorDomains,
            }
          });
        });
      }
    }
    if (!cascade) {
      return rules;
    }
    const tabPresets = new Map();
    for(const {url, id} of tabs) {
      const resourceTypes = ResourceTypeFor.block(policy.get(url).perms.capabilities);
      if (!resourceTypes.length) continue;
      const key = JSON.stringify(resourceTypes);
      if (tabPresets.has(key)) {
        tabPresets.get(key).tabIds.push(id);
      } else {
        tabPresets.set(key, {
          resourceTypes,
          tabIds: [id],
        });
      }
    }
    for (const {resourceTypes, tabIds} of tabPresets.values()) {
      rules.push({
        id: TAB_BASE + rules.length,
        priority: CASCADE_PRIORITY,
        action: {
          type: "block",
        },
        condition: {
          tabIds,
          resourceTypes,
        }
      });
    }
  }

  async function updateTabs() {
    const ts = Date.now();
    const removeRuleIds = (
      await browser.declarativeNetRequest.getSessionRules()
    ).filter(r => r.id >= TAB_BASE && r.id < DYNAMIC_BASE &&
            r.priority <= MAX_PRIORITY && r.condition.tabIds)
      .map(r => r.id);
    const addRules = await addTabRules();
    try {
      await browser.declarativeNetRequest.updateSessionRules({
        addRules,
        removeRuleIds,
      });

    } catch (e) {
      console.error(e, `Failed to update DNRPolicy tab-bound rules (remove %o, add %o)`, addRules, removeRuleIds);
    }
  }

  function autoAllow(tabs, isStartup = false) {
    const {policy} = ns;
    const updated = [];
    if (policy.autoAllowTop) {
      for(const tab of tabs) {
        const { url } = tab;
        if (!url) {
          continue;
        }
        if (Sites.isInternal(url)) {
          updated.push(tab);
          continue;
        }
        const { perms } = policy.get(url);
        console.debug("DNRPolicy autoAllow check", tab, perms, perms === policy.DEFAULT);
        if (policy.autoAllow(url, perms, (isStartup && perms.temp))) {
          updated.push(tab);
        }
      }

    }
    return updated;
  }

  let updatingSemaphore;

  RequestGuard.DNRPolicy = {
    async update() {
      await updatingSemaphore;
      return await (updatingSemaphore = update());
    },
    async updateTabs() {
      await updatingSemaphore;
      return await (updatingSemaphore = updateTabs());
    }
  };

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
      // TODO: see if the update can be made more granular
      autoAllow([tab]).length
        ? Promise.allSettled([RequestGuard.DNRPolicy.update(), ns.saveSession()])
        : RequestGuard.DNRPolicy.updateTabs()
      ;
    }
  });
  /*
  browser.webNavigation.onCommitted.addListener(({tabId, frameType, documentLifecycle, frameId, parentFrameId}) => {
    if (parentFrameId == -1 && autoAllow([{url}])) {
      Promise.allSettled([RequestGuard.DNRPolicy.update(), ns.saveSession()]);
      return;
    }
    RequestGuard.DNRPolicy.updateTabs();
  });
  */
  NavCache.onUrlChanged.addListener((frame) => {
    if (parentFrameId == -1 && autoAllow([{ url }])) {
      Promise.allSettled([RequestGuard.DNRPolicy.update(), ns.saveSession()]);
      return;
    }
    RequestGuard.DNRPolicy.updateTabs();
  });

  let delay;
  browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
    // let's coalesce tabs updates on close
    delay ??= setTimeout(() => {
      delay = undefined;
      RequestGuard.DNRPolicy.updateTabs();
    }, 500);
  });
};

