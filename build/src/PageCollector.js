/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { createIssuesFromProtocolIssue, IssueAggregator, } from '../node_modules/chrome-devtools-frontend/mcp/mcp.js';
import { FakeIssuesManager } from './DevtoolsUtils.js';
import { features } from './features.js';
import { logger } from './logger.js';
function createIdGenerator() {
    let i = 1;
    return () => {
        if (i === Number.MAX_SAFE_INTEGER) {
            i = 0;
        }
        return i++;
    };
}
export const stableIdSymbol = Symbol('stableIdSymbol');
export class PageCollector {
    #browser;
    #listenersInitializer;
    #listeners = new WeakMap();
    #maxNavigationSaved = 3;
    #includeAllPages;
    /**
     * This maps a Page to a list of navigations with a sub-list
     * of all collected resources.
     * The newer navigations come first.
     */
    storage = new WeakMap();
    constructor(browser, listeners, includeAllPages) {
        this.#browser = browser;
        this.#listenersInitializer = listeners;
        this.#includeAllPages = includeAllPages;
    }
    async init() {
        const pages = await this.#browser.pages(this.#includeAllPages);
        for (const page of pages) {
            this.addPage(page);
        }
        this.#browser.on('targetcreated', this.#onTargetCreated);
        this.#browser.on('targetdestroyed', this.#onTargetDestroyed);
    }
    dispose() {
        this.#browser.off('targetcreated', this.#onTargetCreated);
        this.#browser.off('targetdestroyed', this.#onTargetDestroyed);
    }
    #onTargetCreated = async (target) => {
        const page = await target.page();
        if (!page) {
            return;
        }
        this.addPage(page);
    };
    #onTargetDestroyed = async (target) => {
        const page = await target.page();
        if (!page) {
            return;
        }
        this.cleanupPageDestroyed(page);
    };
    addPage(page) {
        this.#initializePage(page);
    }
    #initializePage(page) {
        if (this.storage.has(page)) {
            return;
        }
        const idGenerator = createIdGenerator();
        const storedLists = [[]];
        this.storage.set(page, storedLists);
        const listeners = this.#listenersInitializer(value => {
            const withId = value;
            withId[stableIdSymbol] = idGenerator();
            const navigations = this.storage.get(page) ?? [[]];
            navigations[0].push(withId);
        });
        listeners['framenavigated'] = (frame) => {
            // Only split the storage on main frame navigation
            if (frame !== page.mainFrame()) {
                return;
            }
            this.splitAfterNavigation(page);
        };
        for (const [name, listener] of Object.entries(listeners)) {
            page.on(name, listener);
        }
        this.#listeners.set(page, listeners);
    }
    splitAfterNavigation(page) {
        const navigations = this.storage.get(page);
        if (!navigations) {
            return;
        }
        // Add the latest navigation first
        navigations.unshift([]);
        navigations.splice(this.#maxNavigationSaved);
    }
    cleanupPageDestroyed(page) {
        const listeners = this.#listeners.get(page);
        if (listeners) {
            for (const [name, listener] of Object.entries(listeners)) {
                page.off(name, listener);
            }
        }
        this.storage.delete(page);
    }
    getData(page, includePreservedData) {
        const navigations = this.storage.get(page);
        if (!navigations) {
            return [];
        }
        if (!includePreservedData) {
            return navigations[0];
        }
        const data = [];
        for (let index = this.#maxNavigationSaved; index >= 0; index--) {
            if (navigations[index]) {
                data.push(...navigations[index]);
            }
        }
        return data;
    }
    getIdForResource(resource) {
        return resource[stableIdSymbol] ?? -1;
    }
    getById(page, stableId) {
        const navigations = this.storage.get(page);
        if (!navigations) {
            throw new Error('No requests found for selected page');
        }
        const item = this.find(page, item => item[stableIdSymbol] === stableId);
        if (item) {
            return item;
        }
        throw new Error('Request not found for selected page');
    }
    find(page, filter) {
        const navigations = this.storage.get(page);
        if (!navigations) {
            return;
        }
        for (const navigation of navigations) {
            const item = navigation.find(filter);
            if (item) {
                return item;
            }
        }
        return;
    }
}
export class ConsoleCollector extends PageCollector {
    #subscribedPages = new WeakMap();
    addPage(page) {
        super.addPage(page);
        if (!features.issues) {
            return;
        }
        if (!this.#subscribedPages.has(page)) {
            const subscriber = new PageIssueSubscriber(page);
            this.#subscribedPages.set(page, subscriber);
            void subscriber.subscribe();
        }
    }
    cleanupPageDestroyed(page) {
        super.cleanupPageDestroyed(page);
        this.#subscribedPages.get(page)?.unsubscribe();
        this.#subscribedPages.delete(page);
    }
}
class PageIssueSubscriber {
    #issueManager = new FakeIssuesManager();
    #issueAggregator = new IssueAggregator(this.#issueManager);
    #seenKeys = new Set();
    #seenIssues = new Set();
    #page;
    #session;
    constructor(page) {
        this.#page = page;
        // @ts-expect-error use existing CDP client (internal Puppeteer API).
        this.#session = this.#page._client();
    }
    #resetIssueAggregator() {
        this.#issueManager = new FakeIssuesManager();
        if (this.#issueAggregator) {
            this.#issueAggregator.removeEventListener("AggregatedIssueUpdated" /* IssueAggregatorEvents.AGGREGATED_ISSUE_UPDATED */, this.#onAggregatedissue);
        }
        this.#issueAggregator = new IssueAggregator(this.#issueManager);
        this.#issueAggregator.addEventListener("AggregatedIssueUpdated" /* IssueAggregatorEvents.AGGREGATED_ISSUE_UPDATED */, this.#onAggregatedissue);
    }
    async subscribe() {
        this.#resetIssueAggregator();
        this.#page.on('framenavigated', this.#onFrameNavigated);
        this.#session.on('Audits.issueAdded', this.#onIssueAdded);
        try {
            await this.#session.send('Audits.enable');
        }
        catch (error) {
            logger('Error subscribing to issues', error);
        }
    }
    unsubscribe() {
        this.#seenKeys.clear();
        this.#seenIssues.clear();
        this.#page.off('framenavigated', this.#onFrameNavigated);
        this.#session.off('Audits.issueAdded', this.#onIssueAdded);
        if (this.#issueAggregator) {
            this.#issueAggregator.removeEventListener("AggregatedIssueUpdated" /* IssueAggregatorEvents.AGGREGATED_ISSUE_UPDATED */, this.#onAggregatedissue);
        }
        void this.#session.send('Audits.disable').catch(() => {
            // might fail.
        });
    }
    #onAggregatedissue = (event) => {
        if (this.#seenIssues.has(event.data)) {
            return;
        }
        this.#seenIssues.add(event.data);
        this.#page.emit('issue', event.data);
    };
    // On navigation, we reset issue aggregation.
    #onFrameNavigated = (frame) => {
        // Only split the storage on main frame navigation
        if (frame !== frame.page().mainFrame()) {
            return;
        }
        this.#seenKeys.clear();
        this.#seenIssues.clear();
        this.#resetIssueAggregator();
    };
    #onIssueAdded = (data) => {
        try {
            const inspectorIssue = data.issue;
            // @ts-expect-error Types of protocol from Puppeteer and CDP are
            // incomparable for InspectorIssueCode, one is union, other is enum.
            const issue = createIssuesFromProtocolIssue(null, inspectorIssue)[0];
            if (!issue) {
                logger('No issue mapping for for the issue: ', inspectorIssue.code);
                return;
            }
            const primaryKey = issue.primaryKey();
            if (this.#seenKeys.has(primaryKey)) {
                return;
            }
            this.#seenKeys.add(primaryKey);
            this.#issueManager.dispatchEventToListeners("IssueAdded" /* IssuesManagerEvents.ISSUE_ADDED */, {
                issue,
                // @ts-expect-error We don't care that issues model is null
                issuesModel: null,
            });
        }
        catch (error) {
            logger('Error creating a new issue', error);
        }
    };
}
export class NetworkCollector extends PageCollector {
    #initiators = new WeakMap();
    #cdpListeners = new WeakMap();
    constructor(browser, listeners = collect => {
        return {
            request: req => {
                collect(req);
            },
        };
    }, includeAllPages) {
        super(browser, listeners, includeAllPages);
    }
    addPage(page) {
        super.addPage(page);
        this.#setupInitiatorCollection(page);
    }
    #setupInitiatorCollection(page) {
        if (this.#initiators.has(page)) {
            return;
        }
        const initiatorMap = new Map();
        this.#initiators.set(page, initiatorMap);
        // Listen to CDP events for initiator info
        const onRequestWillBeSent = (event) => {
            if (event.initiator) {
                initiatorMap.set(event.requestId, event.initiator);
            }
        };
        this.#cdpListeners.set(page, onRequestWillBeSent);
        // @ts-expect-error _client is internal Puppeteer API
        const client = page._client();
        client.on('Network.requestWillBeSent', onRequestWillBeSent);
    }
    cleanupPageDestroyed(page) {
        super.cleanupPageDestroyed(page);
        const listener = this.#cdpListeners.get(page);
        if (listener) {
            try {
                // @ts-expect-error _client is internal Puppeteer API
                const client = page._client();
                client.off('Network.requestWillBeSent', listener);
            }
            catch {
                // Page might already be closed
            }
        }
        this.#cdpListeners.delete(page);
        this.#initiators.delete(page);
    }
    /**
     * Get the initiator info for a request.
     * @param page The page the request belongs to
     * @param request The HTTP request
     * @returns The initiator info or undefined if not found
     */
    getInitiator(page, request) {
        const initiatorMap = this.#initiators.get(page);
        if (!initiatorMap) {
            return undefined;
        }
        // @ts-expect-error id is internal Puppeteer API
        const requestId = request.id;
        return initiatorMap.get(requestId);
    }
    /**
     * Get initiator by CDP request ID.
     */
    getInitiatorByRequestId(page, requestId) {
        const initiatorMap = this.#initiators.get(page);
        return initiatorMap?.get(requestId);
    }
    splitAfterNavigation(page) {
        const navigations = this.storage.get(page) ?? [];
        if (!navigations) {
            return;
        }
        const requests = navigations[0];
        const lastRequestIdx = requests.findLastIndex(request => {
            return request.frame() === page.mainFrame()
                ? request.isNavigationRequest()
                : false;
        });
        // Keep all requests since the last navigation request including that
        // navigation request itself.
        // Keep the reference
        if (lastRequestIdx !== -1) {
            const fromCurrentNavigation = requests.splice(lastRequestIdx);
            navigations.unshift(fromCurrentNavigation);
        }
        else {
            navigations.unshift([]);
        }
        // Clear old initiator data on navigation
        const initiatorMap = this.#initiators.get(page);
        if (initiatorMap) {
            initiatorMap.clear();
        }
    }
}
