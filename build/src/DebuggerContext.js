/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * DebuggerContext manages the Chrome DevTools Protocol Debugger domain.
 * It tracks loaded scripts, manages breakpoints, and provides search functionality.
 */
export class DebuggerContext {
    #client = null;
    #scripts = new Map(); // scriptId -> info
    #urlToScripts = new Map(); // url -> scriptId[]
    #breakpoints = new Map(); // breakpointId -> info
    #enabled = false;
    #pausedState = { isPaused: false, callFrames: [] };
    /**
     * Enable the debugger and start tracking scripts.
     */
    async enable(client) {
        if (this.#enabled && this.#client === client) {
            return;
        }
        this.#client = client;
        this.#scripts.clear();
        this.#urlToScripts.clear();
        // Listen for script parsed events
        client.on('Debugger.scriptParsed', this.#onScriptParsed);
        // Listen for paused/resumed events
        client.on('Debugger.paused', this.#onPaused);
        client.on('Debugger.resumed', this.#onResumed);
        // Enable the debugger domain
        await client.send('Debugger.enable');
        // Set async call stack depth for better stack traces
        try {
            await client.send('Debugger.setAsyncCallStackDepth', { maxDepth: 32 });
        }
        catch {
            // Ignore errors - some older versions may not support this
        }
        this.#enabled = true;
    }
    /**
     * Disable the debugger.
     */
    async disable() {
        if (!this.#enabled || !this.#client) {
            return;
        }
        this.#client.off('Debugger.scriptParsed', this.#onScriptParsed);
        this.#client.off('Debugger.paused', this.#onPaused);
        this.#client.off('Debugger.resumed', this.#onResumed);
        try {
            await this.#client.send('Debugger.disable');
        }
        catch {
            // Ignore errors during cleanup
        }
        this.#scripts.clear();
        this.#urlToScripts.clear();
        this.#breakpoints.clear();
        this.#pausedState = { isPaused: false, callFrames: [] };
        this.#enabled = false;
        this.#client = null;
    }
    /**
     * Check if debugger is enabled.
     */
    isEnabled() {
        return this.#enabled;
    }
    /**
     * Get the CDP client.
     */
    getClient() {
        return this.#client;
    }
    #onScriptParsed = (event) => {
        const scriptInfo = {
            scriptId: event.scriptId,
            url: event.url || '',
            startLine: event.startLine,
            startColumn: event.startColumn,
            endLine: event.endLine,
            endColumn: event.endColumn,
            hash: event.hash,
            sourceMapURL: event.sourceMapURL,
        };
        this.#scripts.set(event.scriptId, scriptInfo);
        // Index by URL for quick lookup
        if (event.url) {
            const scriptIds = this.#urlToScripts.get(event.url) || [];
            if (!scriptIds.includes(event.scriptId)) {
                scriptIds.push(event.scriptId);
                this.#urlToScripts.set(event.url, scriptIds);
            }
        }
    };
    #onPaused = (event) => {
        const callFrames = event.callFrames.map(frame => ({
            callFrameId: frame.callFrameId,
            functionName: frame.functionName || '<anonymous>',
            location: {
                scriptId: frame.location.scriptId,
                lineNumber: frame.location.lineNumber,
                columnNumber: frame.location.columnNumber ?? 0,
            },
            url: frame.url || '',
            scopeChain: frame.scopeChain.map(scope => ({
                type: scope.type,
                object: {
                    type: scope.object.type,
                    subtype: scope.object.subtype,
                    className: scope.object.className,
                    value: scope.object.value,
                    description: scope.object.description,
                    objectId: scope.object.objectId,
                },
                name: scope.name,
                startLocation: scope.startLocation
                    ? {
                        scriptId: scope.startLocation.scriptId,
                        lineNumber: scope.startLocation.lineNumber,
                        columnNumber: scope.startLocation.columnNumber ?? 0,
                    }
                    : undefined,
                endLocation: scope.endLocation
                    ? {
                        scriptId: scope.endLocation.scriptId,
                        lineNumber: scope.endLocation.lineNumber,
                        columnNumber: scope.endLocation.columnNumber ?? 0,
                    }
                    : undefined,
            })),
            this: {
                type: frame.this.type,
                subtype: frame.this.subtype,
                className: frame.this.className,
                value: frame.this.value,
                description: frame.this.description,
                objectId: frame.this.objectId,
            },
        }));
        this.#pausedState = {
            isPaused: true,
            reason: event.reason,
            callFrames,
            data: event.data,
            hitBreakpoints: event.hitBreakpoints,
        };
    };
    #onResumed = () => {
        this.#pausedState = { isPaused: false, callFrames: [] };
    };
    // ==================== Paused State Management ====================
    /**
     * Check if execution is paused.
     */
    isPaused() {
        return this.#pausedState.isPaused;
    }
    /**
     * Get the current paused state.
     */
    getPausedState() {
        return this.#pausedState;
    }
    /**
     * Resume execution.
     */
    async resume() {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        if (!this.#pausedState.isPaused) {
            throw new Error('Execution is not paused');
        }
        await this.#client.send('Debugger.resume');
    }
    /**
     * Pause execution.
     */
    async pause() {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        await this.#client.send('Debugger.pause');
    }
    /**
     * Step over the next statement.
     */
    async stepOver() {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        if (!this.#pausedState.isPaused) {
            throw new Error('Execution is not paused');
        }
        await this.#client.send('Debugger.stepOver');
    }
    /**
     * Step into the next function call.
     */
    async stepInto() {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        if (!this.#pausedState.isPaused) {
            throw new Error('Execution is not paused');
        }
        await this.#client.send('Debugger.stepInto');
    }
    /**
     * Step out of the current function.
     */
    async stepOut() {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        if (!this.#pausedState.isPaused) {
            throw new Error('Execution is not paused');
        }
        await this.#client.send('Debugger.stepOut');
    }
    /**
     * Get variables from a scope.
     */
    async getScopeVariables(objectId) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        const result = await this.#client.send('Runtime.getProperties', {
            objectId,
            ownProperties: true,
            accessorPropertiesOnly: false,
            generatePreview: true,
        });
        const variables = [];
        for (const prop of result.result) {
            // Skip internal properties
            if (prop.name.startsWith('__') || prop.name === 'this') {
                continue;
            }
            const value = prop.value;
            if (!value) {
                continue;
            }
            variables.push({
                name: prop.name,
                type: value.type,
                value: value.value ?? value.description ?? `[${value.type}]`,
                description: value.description,
            });
        }
        return variables;
    }
    /**
     * Evaluate expression on a specific call frame.
     */
    async evaluateOnCallFrame(callFrameId, expression, options = {}) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        if (!this.#pausedState.isPaused) {
            throw new Error('Execution is not paused');
        }
        const result = await this.#client.send('Debugger.evaluateOnCallFrame', {
            callFrameId,
            expression,
            returnByValue: options.returnByValue ?? false,
            generatePreview: options.generatePreview ?? true,
        });
        return {
            result: {
                type: result.result.type,
                subtype: result.result.subtype,
                className: result.result.className,
                value: result.result.value,
                description: result.result.description,
                objectId: result.result.objectId,
            },
            exceptionDetails: result.exceptionDetails
                ? {
                    text: result.exceptionDetails.text,
                    exception: result.exceptionDetails.exception
                        ? {
                            type: result.exceptionDetails.exception.type,
                            value: result.exceptionDetails.exception.value,
                            description: result.exceptionDetails.exception.description,
                        }
                        : undefined,
                }
                : undefined,
        };
    }
    // ==================== Script Management ====================
    /**
     * Get all loaded scripts.
     */
    getScripts() {
        return Array.from(this.#scripts.values());
    }
    /**
     * Get scripts by URL (exact match).
     */
    getScriptsByUrl(url) {
        const scriptIds = this.#urlToScripts.get(url) || [];
        return scriptIds
            .map(id => this.#scripts.get(id))
            .filter((s) => s !== undefined);
    }
    /**
     * Get scripts by URL pattern (partial match).
     */
    getScriptsByUrlPattern(pattern) {
        const results = [];
        const lowerPattern = pattern.toLowerCase();
        for (const script of this.#scripts.values()) {
            if (script.url.toLowerCase().includes(lowerPattern)) {
                results.push(script);
            }
        }
        return results;
    }
    /**
     * Get script info by ID.
     */
    getScriptById(scriptId) {
        return this.#scripts.get(scriptId);
    }
    /**
     * Get the source code of a script.
     */
    async getScriptSource(scriptId) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        const result = await this.#client.send('Debugger.getScriptSource', {
            scriptId,
        });
        return result.scriptSource;
    }
    /**
     * Search for a string in all scripts.
     */
    async searchInScripts(query, options = {}) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        const { caseSensitive = false, isRegex = false } = options;
        const matches = [];
        // Search in each script
        for (const script of this.#scripts.values()) {
            // Skip scripts without URLs (inline scripts, eval, etc.)
            // unless they have meaningful content
            if (!script.url && !script.hash) {
                continue;
            }
            try {
                const result = await this.#client.send('Debugger.searchInContent', {
                    scriptId: script.scriptId,
                    query,
                    caseSensitive,
                    isRegex,
                });
                for (const match of result.result) {
                    matches.push({
                        scriptId: script.scriptId,
                        url: script.url,
                        lineNumber: match.lineNumber,
                        lineContent: match.lineContent,
                    });
                }
            }
            catch {
                // Skip scripts that can't be searched (e.g., wasm)
            }
        }
        return { query, matches };
    }
    // ==================== Breakpoint Management ====================
    /**
     * Set a breakpoint by URL.
     */
    async setBreakpoint(url, lineNumber, columnNumber = 0, condition) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        const params = {
            url,
            lineNumber,
            columnNumber,
        };
        if (condition) {
            params.condition = condition;
        }
        const result = await this.#client.send('Debugger.setBreakpointByUrl', params);
        const breakpointInfo = {
            breakpointId: result.breakpointId,
            url,
            lineNumber,
            columnNumber,
            condition,
            locations: result.locations.map(loc => ({
                scriptId: loc.scriptId,
                lineNumber: loc.lineNumber,
                columnNumber: loc.columnNumber ?? 0,
            })),
        };
        this.#breakpoints.set(result.breakpointId, breakpointInfo);
        return breakpointInfo;
    }
    /**
     * Set a breakpoint by URL regex pattern.
     */
    async setBreakpointByUrlRegex(urlRegex, lineNumber, columnNumber = 0, condition) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        const params = {
            urlRegex,
            lineNumber,
            columnNumber,
        };
        if (condition) {
            params.condition = condition;
        }
        const result = await this.#client.send('Debugger.setBreakpointByUrl', params);
        const breakpointInfo = {
            breakpointId: result.breakpointId,
            url: urlRegex, // Store the regex as the URL
            lineNumber,
            columnNumber,
            condition,
            locations: result.locations.map(loc => ({
                scriptId: loc.scriptId,
                lineNumber: loc.lineNumber,
                columnNumber: loc.columnNumber ?? 0,
            })),
        };
        this.#breakpoints.set(result.breakpointId, breakpointInfo);
        return breakpointInfo;
    }
    /**
     * Remove a breakpoint.
     */
    async removeBreakpoint(breakpointId) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        await this.#client.send('Debugger.removeBreakpoint', { breakpointId });
        this.#breakpoints.delete(breakpointId);
    }
    /**
     * Remove all breakpoints.
     */
    async removeAllBreakpoints() {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        const breakpointIds = Array.from(this.#breakpoints.keys());
        for (const breakpointId of breakpointIds) {
            try {
                await this.removeBreakpoint(breakpointId);
            }
            catch {
                // Ignore errors for individual breakpoints
            }
        }
    }
    /**
     * Get all active breakpoints.
     */
    getBreakpoints() {
        return Array.from(this.#breakpoints.values());
    }
    /**
     * Get breakpoint by ID.
     */
    getBreakpointById(breakpointId) {
        return this.#breakpoints.get(breakpointId);
    }
}
