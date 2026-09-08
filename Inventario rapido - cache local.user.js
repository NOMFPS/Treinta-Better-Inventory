// ==UserScript==
// @name         Treinta - Inventario rápido (caché local)
// @namespace    https://zafiro.local/tampermonkey
// @version      1.0.7
// @description  Guarda el inventario de Treinta en IndexedDB y responde búsquedas desde el caché local.
// @author       Zafiro
// @match        https://web.treinta.co/new-sale*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const API_RE = /^https:\/\/web-api-gateway\.treinta\.co\/manager\/([^/]+)\/products\/summary-with-taxes(?:\?|$)/i;
    const DB_NAME = 'treinta-local-inventory-cache';
    const DB_VERSION = 1;
    const PAGE_SIZE = 50;
    const SYNC_CONCURRENCY = 4;
    const FULL_SYNC_TTL_MS = 10 * 60 * 1000;
    const SEARCH_INPUT_ID = 'biome-sarch-input';
    const SEARCH_TIMER_WINDOW_MS = 150;
    const MAX_SEARCH_DEBOUNCE_MS = 1200;
    const UI_ID = 'tm-treinta-inventory-cache';
    const STYLE_ID = 'tm-treinta-inventory-cache-style';

    const NativeXHR = window.XMLHttpRequest;
    const nativeFetch = window.fetch?.bind(window);
    const xhrMeta = new WeakMap();
    const backgroundXHR = new WeakSet();

    const state = {
        db: null,
        dbReady: null,
        ready: false,
        storeId: null,
        total: 0,
        pageSize: PAGE_SIZE,
        pages: new Set(),
        products: new Map(),
        authHeaders: {},
        lastFullSyncAt: 0,
        syncing: false,
        clearing: false,
        syncQueued: false,
        syncSeen: null,
        lastContext: null,
        lastMessage: 'Preparando caché local…',
        ui: null,
        lastSearchInputAt: 0
    };

    function log(...args) {
        console.debug('[Treinta caché]', ...args);
    }

    function warn(...args) {
        console.warn('[Treinta caché]', ...args);
    }

    function getApiInfo(url) {
        try {
            const parsed = new URL(String(url), location.href);
            const match = parsed.href.match(API_RE);
            if (!match) return null;
            return { url: parsed, storeId: match[1] };
        } catch {
            return null;
        }
    }

    function isTreintaApiUrl(url) {
        try {
            return /(?:^|\.)treinta\.co$/i.test(new URL(String(url), location.href).hostname);
        } catch {
            return false;
        }
    }

    function asURL(value) {
        try {
            return value instanceof URL ? value : new URL(String(value), location.href);
        } catch {
            return null;
        }
    }

    function hasSearch(value) {
        const url = asURL(value);
        return Boolean(url?.searchParams.get('search')?.trim());
    }

    function isPlainInventoryRequest(url) {
        const ignored = new Set(['page', 'limit', 'search']);
        for (const key of url.searchParams.keys()) {
            if (!ignored.has(key)) return false;
        }
        return true;
    }

    function normalize(value) {
        return String(value ?? '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLocaleLowerCase('es');
    }

    function productSearchText(product) {
        return normalize([
            product.name,
            product.sku,
            product.categoryName,
            product.notes
        ].filter(Boolean).join(' '));
    }

    function searchTokens(value) {
        return normalize(value).split(/[^a-z0-9]+/).filter(Boolean);
    }

    function hasTokenSequence(tokens, queryTokens) {
        if (!queryTokens.length || queryTokens.length > tokens.length) return false;
        for (let start = 0; start <= tokens.length - queryTokens.length; start++) {
            let matches = true;
            for (let index = 0; index < queryTokens.length; index++) {
                if (tokens[start + index] !== queryTokens[index]) {
                    matches = false;
                    break;
                }
            }
            if (matches) return true;
        }
        return false;
    }

    function searchScore(product, query, queryTokens, originalIndex) {
        const name = normalize(product.name);
        const nameTokens = searchTokens(name);
        const exactNameMatches = queryTokens.filter(term => nameTokens.includes(term)).length;
        const substringMatches = queryTokens.filter(term => name.includes(term)).length;
        const exactName = name === query;
        const startsWithTerms = hasTokenSequence(nameTokens, queryTokens) && nameTokens.length >= queryTokens.length &&
            queryTokens.every((term, index) => nameTokens[index] === term);
        const containsPhrase = hasTokenSequence(nameTokens, queryTokens);

        let score = 0;
        if (exactName) score += 1_000_000_000;
        else if (startsWithTerms) score += 800_000_000;
        else if (containsPhrase) score += 650_000_000;

        // Una coincidencia completa en el nombre gana a cualquier coincidencia
        // repartida entre nombre, categoría, SKU o notas.
        if (exactNameMatches === queryTokens.length) score += 500_000_000;
        score += exactNameMatches * 10_000_000;
        score += substringMatches * 100_000;

        // Si empatan, conservar el orden original del inventario.
        return score - originalIndex;
    }

    function getProductsFor(url) {
        const search = normalize(url.searchParams.get('search')).trim();
        const terms = search.split(/\s+/).filter(Boolean);
        const queryTokens = searchTokens(search);
        const all = Array.from(state.products.values());
        const filtered = terms.length === 0 ? all : all.filter(product => {
            const text = product._searchText || (product._searchText = productSearchText(product));
            return terms.every(term => text.includes(term));
        }).map((product, originalIndex) => ({
            product,
            originalIndex,
            score: searchScore(product, search, queryTokens, originalIndex)
        }))
            .sort((left, right) => right.score - left.score)
            .map(item => item.product);

        const limit = Math.max(1, Number(url.searchParams.get('limit')) || PAGE_SIZE);
        const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
        const start = (page - 1) * limit;

        return {
            data: filtered.slice(start, start + limit).map(stripInternalFields),
            limit,
            page,
            total: filtered.length
        };
    }

    function stripInternalFields(product) {
        const copy = { ...product };
        delete copy._searchText;
        return copy;
    }

    function hasCompleteCache() {
        return state.ready && state.lastFullSyncAt > 0 && state.storeId && state.total > 0 &&
            state.pages.size >= Math.ceil(state.total / state.pageSize) &&
            state.products.size >= state.total;
    }

    function canServeLocally(url) {
        const info = getApiInfo(url);
        return hasCompleteCache() && state.storeId === info?.storeId &&
            hasSearch(url) && isPlainInventoryRequest(url);
    }

    function openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'storeId' });
                }
                if (!db.objectStoreNames.contains('products')) {
                    const products = db.createObjectStore('products', { keyPath: 'cacheKey' });
                    products.createIndex('storeId', 'storeId', { unique: false });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('No se pudo abrir IndexedDB'));
        });
    }

    function loadCachedStore(storeId) {
        if (!state.db) return Promise.resolve();

        return new Promise((resolve, reject) => {
            const tx = state.db.transaction(['meta', 'products'], 'readonly');
            const metaRequest = tx.objectStore('meta').get(storeId);
            const productRequest = tx.objectStore('products').index('storeId').getAll(storeId);

            tx.oncomplete = () => {
                const meta = metaRequest.result;
                state.storeId = storeId;
                state.total = Number(meta?.total) || 0;
                state.pageSize = Number(meta?.pageSize) || PAGE_SIZE;
                state.pages = new Set(Array.isArray(meta?.pages) ? meta.pages : []);
                state.lastFullSyncAt = Number(meta?.fullSyncAt) || 0;
                state.products.clear();
                for (const product of productRequest.result || []) {
                    delete product.cacheKey;
                    product._searchText = productSearchText(product);
                    state.products.set(product.id, product);
                }
                state.ready = true;
                state.lastMessage = state.products.size
                    ? `Caché local: ${state.products.size.toLocaleString('es-CO')} productos`
                    : 'Esperando la primera carga del inventario…';
                updateUI();
                resolve();
            };
            tx.onerror = () => reject(tx.error || new Error('No se pudo leer el caché'));
        });
    }

    function persistPage(storeId, page, limit, total, products, options = {}) {
        if (!state.db) return Promise.resolve();

        return new Promise((resolve, reject) => {
            const tx = state.db.transaction(['meta', 'products'], 'readwrite');
            const metaStore = tx.objectStore('meta');
            const productStore = tx.objectStore('products');
            const currentRequest = metaStore.get(storeId);

            currentRequest.onsuccess = () => {
                const previous = currentRequest.result || {
                    storeId,
                    pages: [],
                    pageSize: limit
                };
                const oldTotal = Number(previous.total) || 0;
                const pages = new Set(Array.isArray(previous.pages) ? previous.pages : []);

                if (oldTotal && oldTotal !== total) pages.clear();
                pages.add(page);

                for (const product of products) {
                    if (!product?.id) continue;
                    const clean = stripInternalFields(product);
                    productStore.put({
                        ...clean,
                        storeId,
                        cacheKey: `${storeId}:${clean.id}`
                    });
                }

                metaStore.put({
                    storeId,
                    total,
                    pageSize: limit,
                    pages: Array.from(pages).sort((a, b) => a - b),
                    complete: pages.size >= Math.ceil(total / limit),
                    updatedAt: Date.now(),
                    fullSyncAt: Object.prototype.hasOwnProperty.call(options, 'fullSyncAt')
                        ? options.fullSyncAt
                        : (previous.fullSyncAt || 0)
                });
            };

            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('No se pudo guardar el caché'));
        });
    }

    async function mergePage(storeId, page, limit, total, products, options = {}) {
        if (state.storeId !== storeId || (state.total && state.total !== total)) {
            state.products.clear();
            state.pages.clear();
        }

        state.storeId = storeId;
        state.total = total;
        state.pageSize = limit || PAGE_SIZE;
        state.pages.add(page);

        for (const product of products) {
            if (!product?.id) continue;
            product._searchText = productSearchText(product);
            state.products.set(product.id, product);
            if (state.syncSeen) state.syncSeen.add(product.id);
        }

        state.ready = true;
        state.lastMessage = `Cargando caché: ${Math.min(state.products.size, state.total).toLocaleString('es-CO')} / ${state.total.toLocaleString('es-CO')}`;
        updateUI();
        await state.dbReady;
        await persistPage(storeId, page, limit || PAGE_SIZE, total, products, options);
    }

    function parseInventoryPayload(text) {
        try {
            const payload = JSON.parse(text);
            if (!payload || !Array.isArray(payload.data)) return null;
            return {
                data: payload.data,
                page: Number(payload.page) || 1,
                limit: Number(payload.limit) || PAGE_SIZE,
                total: Number(payload.total) || payload.data.length
            };
        } catch {
            return null;
        }
    }

    async function captureInventory(url, payload, headers = {}) {
        const info = getApiInfo(url);
        if (!info || !payload) return;

        rememberHeaders(headers);
        const previousStoreId = state.storeId;
        if (previousStoreId !== info.storeId) {
            await state.dbReady;
            await loadCachedStore(info.storeId);
        }
        captureContext(url, payload);

        if (!hasSearch(url)) {
            await mergePage(info.storeId, payload.page, payload.limit, payload.total, payload.data, {
                fullSyncAt: undefined
            });
        } else {
            for (const product of payload.data) {
                if (!product?.id) continue;
                product._searchText = productSearchText(product);
                state.products.set(product.id, product);
            }
            state.ready = true;
            updateUI();
        }

        if (!hasSearch(info.url)) {
            const totalPages = Math.ceil(payload.total / (payload.limit || PAGE_SIZE));
            if (state.pages.size < totalPages || Date.now() - state.lastFullSyncAt > FULL_SYNC_TTL_MS) {
                queueFullSync('Calentando caché local');
            }
        }
    }

    function getHeaderObject(headers) {
        const result = {};
        if (!headers) return result;
        if (typeof headers.forEach === 'function') {
            headers.forEach((value, key) => {
                result[String(key).toLowerCase()] = String(value);
            });
            return result;
        }
        for (const [key, value] of Object.entries(headers)) {
            result[String(key).toLowerCase()] = String(value);
        }
        return result;
    }

    function rememberHeaders(headers) {
        const incoming = getHeaderObject(headers);
        for (const key of [
            'authorization',
            'x-api-key',
            'x-device-time',
            'x-hash-signature',
            'x-lang',
            'x-treinta-fingerprint',
            'x-web-app-version'
        ]) {
            if (incoming[key]) state.authHeaders[key] = incoming[key];
        }
    }

    function defineResponseValues(xhr, url, payloadText) {
        const parsed = JSON.parse(payloadText);
        const values = {
            readyState: 4,
            status: 200,
            statusText: 'OK',
            responseURL: url,
            responseText: payloadText,
            response: xhr.responseType === 'json' ? parsed : payloadText,
            getAllResponseHeaders: () => 'content-type: application/json; charset=utf-8\r\n'
        };

        for (const [key, value] of Object.entries(values)) {
            try {
                Object.defineProperty(xhr, key, {
                    configurable: true,
                    enumerable: true,
                    get: typeof value === 'function' ? () => value : () => value
                });
            } catch {
                // Algunos navegadores no permiten sombrear ciertas propiedades XHR.
            }
        }
    }

    function emitLocalResponse(xhr, url, payload) {
        const payloadText = JSON.stringify(payload);
        try {
            defineResponseValues(xhr, url.href, payloadText);
        } catch (error) {
            warn('No se pudo preparar la respuesta local:', error);
            return;
        }

        const emit = type => {
            try {
                xhr.dispatchEvent(new Event(type));
            } catch {
                if (type === 'readystatechange' && typeof xhr.onreadystatechange === 'function') {
                    xhr.onreadystatechange.call(xhr, new Event(type));
                }
            }
        };

        queueMicrotask(() => {
            emit('readystatechange');
            emit('load');
            emit('loadend');
        });
    }

    function serveLocalXHR(xhr, url) {
        const meta = xhrMeta.get(xhr);
        if (meta) meta.local = true;
        try {
            emitLocalResponse(xhr, url, getProductsFor(url));
        } catch (error) {
            warn('Falló la búsqueda local:', error);
            NativeXHR.prototype.abort.call(xhr);
        }
    }

    function installXHRHook() {
        const open = NativeXHR.prototype.open;
        const setRequestHeader = NativeXHR.prototype.setRequestHeader;
        const send = NativeXHR.prototype.send;

        NativeXHR.prototype.open = function (method, url, ...rest) {
            const parsed = getApiInfo(url);
            xhrMeta.set(this, {
                method: String(method || 'GET').toUpperCase(),
                url: String(url),
                parsed,
                headers: {}
            });
            return open.call(this, method, url, ...rest);
        };

        NativeXHR.prototype.setRequestHeader = function (name, value) {
            const meta = xhrMeta.get(this);
            if (meta) meta.headers[String(name).toLowerCase()] = String(value);
            return setRequestHeader.call(this, name, value);
        };

        NativeXHR.prototype.send = function (body) {
            const meta = xhrMeta.get(this);
            const parsed = meta?.parsed;

            if (meta && parsed && canServeLocally(parsed.url)) {
                serveLocalXHR(this, parsed.url);
                return undefined;
            }

            if (meta && parsed && !backgroundXHR.has(this)) {
                rememberHeaders(meta.headers);
                this.addEventListener('loadend', () => {
                    if (meta.local) return;
                    if (this.status >= 200 && this.status < 300) {
                        const payload = parseInventoryPayload(this.responseText);
                        if (payload) void captureInventory(meta.url, payload, meta.headers);
                    }
                }, { once: true });
            }

            if (meta && meta.method !== 'GET' && isTreintaApiUrl(meta.url) && !backgroundXHR.has(this)) {
                this.addEventListener('loadend', () => {
                    if (this.status >= 200 && this.status < 300) queueFullSync('Actualización detectada');
                }, { once: true });
            }

            return send.call(this, body);
        };
    }

    function installFetchHook() {
        if (!nativeFetch) return;

        window.fetch = async function (input, init) {
            const rawUrl = typeof input === 'string' ? input : input?.url;
            const info = getApiInfo(rawUrl);
            const method = String(init?.method || input?.method || 'GET').toUpperCase();

            if (info && canServeLocally(info.url)) {
                return new Response(JSON.stringify(getProductsFor(info.url)), {
                    status: 200,
                    headers: { 'content-type': 'application/json; charset=utf-8' }
                });
            }

            const headers = { ...getHeaderObject(input?.headers), ...getHeaderObject(init?.headers) };
            if (info) rememberHeaders(headers);

            const response = await nativeFetch(input, init);
            if (info && response.ok) {
                response.clone().text().then(text => {
                    const payload = parseInventoryPayload(text);
                    if (payload) void captureInventory(info.url.href, payload, headers);
                }).catch(() => {});
            }
            if (method !== 'GET' && response.ok && isTreintaApiUrl(rawUrl)) queueFullSync('Actualización detectada');
            return response;
        };
    }

    function isSearchInput(target) {
        if (!target || target.nodeType !== Node.ELEMENT_NODE) return false;
        if (target.id === SEARCH_INPUT_ID) return true;
        if (target.tagName !== 'INPUT') return false;
        return target.type === 'search' || target.getAttribute('role') === 'searchbox';
    }

    function getSearchInput() {
        return document.getElementById(SEARCH_INPUT_ID) ||
            document.querySelector('input[type="search"], input[role="searchbox"]');
    }

    function isEditableTarget(target) {
        if (!target || target.nodeType !== Node.ELEMENT_NODE) return false;
        if (target.isContentEditable) return true;
        return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    }

    function setInputValue(input, value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, value);
        else input.value = value;

        const inputEvent = typeof InputEvent === 'function'
            ? new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null })
            : new Event('input', { bubbles: true });
        input.dispatchEvent(inputEvent);
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function clearSearchAndFocus() {
        const input = getSearchInput();
        if (!input) return;
        input.focus({ preventScroll: true });
        if (input.value) setInputValue(input, '');
    }

    function installKeyboardBinds() {
        document.addEventListener('keydown', event => {
            const input = getSearchInput();
            if (!input) return;

            const searchFocused = document.activeElement === input || isSearchInput(event.target);

            if (event.key === 'Backspace' && !searchFocused && !isEditableTarget(event.target)) {
                event.preventDefault();
                event.stopImmediatePropagation();
                clearSearchAndFocus();
                return;
            }

            if (event.key === 'Enter' && searchFocused) {
                event.preventDefault();
                event.stopImmediatePropagation();
                input.blur();
                return;
            }

        }, true);
    }

    function installInstantSearchHook() {
        const nativeSetTimeout = window.setTimeout.bind(window);

        document.addEventListener('input', event => {
            if (isSearchInput(event.target)) state.lastSearchInputAt = performance.now();
        }, true);

        window.setTimeout = function (handler, timeout, ...args) {
            const requestedDelay = Number(timeout) || 0;
            const inputAge = performance.now() - state.lastSearchInputAt;
            const isRecentSearch = inputAge >= 0 && inputAge <= SEARCH_TIMER_WINDOW_MS;
            const looksLikeDebounce = requestedDelay >= 50 && requestedDelay <= MAX_SEARCH_DEBOUNCE_MS;
            const effectiveDelay = hasCompleteCache() && isRecentSearch && looksLikeDebounce ? 0 : timeout;
            return nativeSetTimeout(handler, effectiveDelay, ...args);
        };
    }

    function makePageUrl(baseUrl, page, limit) {
        const url = new URL(baseUrl);
        url.search = '';
        url.searchParams.set('page', String(page));
        url.searchParams.set('limit', String(limit));
        return url;
    }

    function fetchInventoryPage(baseUrl, page, limit, headers) {
        return new Promise((resolve, reject) => {
            const xhr = new NativeXHR();
            backgroundXHR.add(xhr);
            xhr.open('GET', makePageUrl(baseUrl, page, limit).href, true);
            xhr.timeout = 30000;

            const requestHeaders = { ...headers, 'x-device-time': String(Date.now()) };
            for (const [key, value] of Object.entries(requestHeaders)) {
                if (value) {
                    try {
                        xhr.setRequestHeader(key, value);
                    } catch {
                        // Ignorar encabezados que el navegador marque como restringidos.
                    }
                }
            }

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    const payload = parseInventoryPayload(xhr.responseText);
                    if (payload) {
                        void mergePage(state.storeId, payload.page, payload.limit, payload.total, payload.data, {
                            fullSyncAt: undefined
                        }).then(() => resolve(payload)).catch(reject);
                        return;
                    }
                }
                reject(new Error(`HTTP ${xhr.status || 0} en página ${page}`));
            };
            xhr.onerror = () => reject(new Error(`Error de red en página ${page}`));
            xhr.ontimeout = () => reject(new Error(`Tiempo agotado en página ${page}`));
            xhr.send();
        });
    }

    async function pruneAfterFullSync() {
        if (!state.syncSeen || !state.db) return;
        const seen = state.syncSeen;
        const removed = [];

        for (const [id, product] of state.products) {
            if (!seen.has(id)) {
                state.products.delete(id);
                removed.push({ storeId: state.storeId, cacheKey: `${state.storeId}:${id}` });
            }
        }

        if (!removed.length) return;
        await new Promise((resolve, reject) => {
            const tx = state.db.transaction('products', 'readwrite');
            const store = tx.objectStore('products');
            for (const item of removed) store.delete(item.cacheKey);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('No se pudo limpiar el caché'));
        });
    }

    async function fullSync(reason = 'Sincronizando inventario') {
        if (state.syncing || !state.lastContext || !Object.keys(state.authHeaders).length) {
            state.syncQueued = true;
            return;
        }

        state.syncing = true;
        state.syncQueued = false;
        state.syncSeen = new Set();
        state.lastMessage = `${reason}…`;
        updateUI();

        try {
            const context = state.lastContext;
            await state.dbReady;
            // Mantener vigente la última instantánea completa mientras se
            // actualiza en segundo plano. Solo se reemplaza al finalizar.
            await persistPage(state.storeId, 1, context.limit, state.total, [], {
                fullSyncAt: state.lastFullSyncAt
            });
            const totalPages = Math.max(1, Math.ceil(state.total / context.limit));
            const pages = [];
            for (let page = 1; page <= totalPages; page++) pages.push(page);

            let nextIndex = 0;
            const worker = async () => {
                while (nextIndex < pages.length) {
                    const page = pages[nextIndex++];
                    try {
                        await fetchInventoryPage(context.baseUrl, page, context.limit, state.authHeaders);
                    } catch (error) {
                        warn(error.message);
                        state.lastMessage = `Caché parcial: error en página ${page}`;
                    }
                }
            };

            await Promise.all(Array.from({ length: Math.min(SYNC_CONCURRENCY, pages.length) }, worker));
            const complete = state.pages.size >= totalPages && state.syncSeen.size >= Math.min(state.total, state.products.size);
            if (complete) {
                await pruneAfterFullSync();
                state.lastFullSyncAt = Date.now();
                state.lastMessage = `Caché listo: ${state.products.size.toLocaleString('es-CO')} productos`;
                await persistPage(state.storeId, 1, context.limit, state.total, [], { fullSyncAt: state.lastFullSyncAt });
            } else if (!state.lastMessage.includes('error')) {
                state.lastMessage = `Caché parcial: ${state.products.size.toLocaleString('es-CO')} productos`;
            }
        } catch (error) {
            warn('No se pudo completar la sincronización:', error);
            state.lastMessage = 'Caché parcial; pulsa Actualizar para reintentar';
        }

        state.syncSeen = null;
        state.syncing = false;
        updateUI();

        if (state.syncQueued) void fullSync('Sincronizando cambios pendientes');
    }

    function queueFullSync(reason) {
        clearTimeout(queueFullSync.timer);
        queueFullSync.timer = setTimeout(() => {
            void fullSync(reason);
        }, 1500);
    }

    function clearDatabaseCache() {
        if (!state.db) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const tx = state.db.transaction(['meta', 'products'], 'readwrite');
            tx.objectStore('meta').clear();
            tx.objectStore('products').clear();
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('No se pudo borrar el caché'));
        });
    }

    async function clearCacheAndRebuild() {
        if (state.syncing || state.clearing) return;

        state.clearing = true;
        const context = state.lastContext ? { ...state.lastContext } : null;
        state.lastMessage = 'Borrando caché local…';
        updateUI();

        try {
            await state.dbReady;
            await clearDatabaseCache();
            state.products.clear();
            state.pages.clear();
            state.lastFullSyncAt = 0;
            state.syncSeen = null;
            state.ready = false;

            if (!context) {
                state.storeId = null;
                state.total = 0;
                state.pageSize = PAGE_SIZE;
                state.lastMessage = 'Caché borrado; esperando el inventario…';
                updateUI();
                return;
            }

            state.total = Number(context.total) || 0;
            state.pageSize = Number(context.limit) || PAGE_SIZE;
            state.lastMessage = 'Reconstruyendo caché local…';
            updateUI();
            await fullSync('Reconstruyendo caché');
        } catch (error) {
            state.lastMessage = 'No se pudo borrar el caché local';
            warn('No se pudo borrar el caché:', error);
            updateUI();
        } finally {
            state.clearing = false;
            updateUI();
        }
    }

    function captureContext(url, payload) {
        const info = getApiInfo(url);
        if (!info || hasSearch(info.url)) return;
        if (state.total && state.total !== payload.total) {
            state.pages.clear();
            state.lastFullSyncAt = 0;
        }
        state.lastContext = {
            baseUrl: info.url.href,
            limit: payload.limit || PAGE_SIZE,
            total: payload.total
        };
        state.total = payload.total;
        state.pageSize = payload.limit || PAGE_SIZE;
    }

    function addStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${UI_ID} {
                display: flex;
                flex-direction: column;
                gap: 2px;
                width: 100%;
                margin: 4px 0;
                color: inherit;
                font: inherit;
            }

            #${UI_ID} .tm-cache-menu-button {
                box-sizing: border-box;
                display: flex;
                align-items: center;
                width: 100%;
                min-height: 38px;
                padding: 9px 16px;
                border: 0;
                border-radius: 6px;
                background: transparent;
                color: inherit;
                cursor: pointer;
                font: inherit;
                text-align: left;
            }

            #${UI_ID} .tm-cache-menu-button:hover:not(:disabled) {
                background: rgba(23, 50, 77, .08);
            }

            #${UI_ID} .tm-cache-count {
                cursor: default;
                user-select: none;
            }

            #${UI_ID} .tm-cache-count:hover {
                background: transparent;
            }

            #${UI_ID} .tm-cache-dot {
                width: 8px;
                height: 8px;
                margin-right: 10px;
                border-radius: 50%;
                background: #f3b51b;
            }
            #${UI_ID}[data-ready="true"] .tm-cache-dot { background: #20a878; }
            #${UI_ID} .tm-cache-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            #${UI_ID} button:disabled { cursor: wait; opacity: .55; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function findLogoutItem() {
        const elements = document.querySelectorAll('a, button, [role="button"]');
        for (const element of elements) {
            if (normalize(element.textContent).trim() === 'cerrar sesion') return element;
        }
        return null;
    }

    function placeUI(root) {
        const logout = findLogoutItem();
        if (logout?.parentElement) {
            const logoutItem = logout.closest('li') || logout;
            const parent = logoutItem.parentElement;
            if (parent && root !== logoutItem) {
                parent.insertBefore(root, logoutItem);
                root.dataset.placement = 'menu';
                return;
            }
        }
        if (!root.parentElement) document.body.appendChild(root);
        root.dataset.placement = 'fallback';
    }

    function ensureUI() {
        if (!document.body) return;
        const existing = document.getElementById(UI_ID);
        if (existing) {
            state.ui = existing;
            placeUI(existing);
            return;
        }
        addStyles();
        const root = document.createElement('div');
        root.id = UI_ID;
        root.innerHTML = `
            <div class="tm-cache-menu-button tm-cache-count" role="status" aria-live="polite" title="Estado del caché local">
                <span class="tm-cache-dot"></span><span class="tm-cache-label"></span>
            </div>
            <button class="tm-cache-menu-button" data-action="clear" type="button" title="Borrar el caché local y reconstruirlo">Borrar caché</button>
            <button class="tm-cache-menu-button" data-action="refresh" type="button" title="Descargar nuevamente el inventario desde Treinta">Actualizar</button>
        `;
        root.querySelector('[data-action="clear"]').addEventListener('click', () => {
            void clearCacheAndRebuild();
        });
        root.querySelector('[data-action="refresh"]').addEventListener('click', () => {
            void fullSync('Actualizando inventario');
        });
        placeUI(root);
        state.ui = root;
        updateUI();
    }

    function updateUI() {
        if (!state.ui || !document.contains(state.ui)) return;
        placeUI(state.ui);
        const label = state.ui.querySelector('.tm-cache-label');
        const clearButton = state.ui.querySelector('[data-action="clear"]');
        const refreshButton = state.ui.querySelector('[data-action="refresh"]');
        label.textContent = state.products.size
            ? `${state.products.size.toLocaleString('es-CO')} productos`
            : 'Caché preparando…';
        state.ui.title = state.lastMessage;
        clearButton.disabled = state.syncing || state.clearing;
        refreshButton.disabled = state.syncing || state.clearing;
        state.ui.dataset.ready = hasCompleteCache() ? 'true' : 'false';
    }

    function startUIObserver() {
        const init = () => {
            ensureUI();
            if (!state.ui || state.ui.dataset.placement !== 'menu') setTimeout(init, 500);
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init, { once: true });
        } else {
            init();
        }
    }

    async function initialize() {
        try {
            state.db = await openDatabase();
        } catch (error) {
            state.ready = false;
            state.lastMessage = 'Caché local no disponible; Treinta funcionará normal';
            warn(error.message);
            updateUI();
        }
    }

    installXHRHook();
    installFetchHook();
    installInstantSearchHook();
    installKeyboardBinds();
    startUIObserver();

    state.dbReady = initialize();
    log('Userscript instalado');
})();
