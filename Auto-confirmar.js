// ==UserScript==
// @name         Auto-Confirmar con Tecla
// @namespace    http://tampermonkey.net/
// @version      2.0.2
// @description  Automatiza ventas con factura o venta rápida usando el teclado numérico.
// @author       @NOMFPS
// @match        https://web.treinta.co/new-sale*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const SELECTORS = {
        basket: '[data-testid="basketButton_default"]',
        confirmProducts: '[data-testid="balance_sale_button_confirm"]',
        printTicket: '[data-testid="balance_sale_button_print_ticket"]',
        calculatorConfirm: '[data-testid="calculator-modal__confirm-button"]',
        newSale: '[data-testid="balanceSale_button_newSale"]'
    };

    const WAIT_TIMEOUT_MS = 10_000;
    const PRINTER_PREPARE_DELAY_MS = 600;
    let saleInProgress = false;

    function log(...args) {
        console.debug('[Treinta auto-confirmar]', ...args);
    }

    function warn(...args) {
        console.warn('[Treinta auto-confirmar]', ...args);
    }

    function isEditableTarget(target) {
        if (!target || target.nodeType !== Node.ELEMENT_NODE) return false;
        if (target.isContentEditable) return true;
        return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    }

    function isUsableButton(selector) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
            if (element.disabled || element.getAttribute('aria-disabled') === 'true') continue;
            const style = window.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            if (!element.getClientRects().length) continue;
            return element;
        }
        return null;
    }

    function waitForButton(selector, timeout = WAIT_TIMEOUT_MS) {
        const existing = isUsableButton(selector);
        if (existing) return Promise.resolve(existing);

        return new Promise((resolve, reject) => {
            const root = document.body || document.documentElement;
            let timer;
            let finished = false;
            const observer = new MutationObserver(check);

            function finish(callback, value) {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                observer.disconnect();
                callback(value);
            }

            function check() {
                const button = isUsableButton(selector);
                if (button) finish(resolve, button);
            }

            timer = setTimeout(() => {
                finish(reject, new Error(`No apareció el botón ${selector}`));
            }, timeout);

            observer.observe(root, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['aria-disabled', 'class', 'disabled', 'style']
            });
            check();
        });
    }

    async function clickButton(selector, label) {
        const button = await waitForButton(selector);
        button.click();
        log(label);
        return button;
    }

    function wait(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    async function clickPrinterAfterContinue() {
        // Después de abrir la canasta, Treinta necesita preparar el módulo de
        // impresión antes de que el botón pueda usarse sin mostrar "no hay impresoras".
        await wait(PRINTER_PREPARE_DELAY_MS);
        await clickButton(SELECTORS.printTicket, 'Factura/ticket seleccionado');
    }

    async function clickPrinterFromOpenSale() {
        await clickButton(SELECTORS.printTicket, 'Factura/ticket seleccionado');
    }

    function dispatchEscape() {
        const targets = [document, window, document.activeElement].filter(Boolean);
        const uniqueTargets = [...new Set(targets)];

        for (const type of ['keydown', 'keyup']) {
            for (const target of uniqueTargets) {
                target.dispatchEvent(new KeyboardEvent(type, {
                    key: 'Escape',
                    code: 'Escape',
                    keyCode: 27,
                    which: 27,
                    bubbles: true,
                    cancelable: true
                }));
            }
        }
    }

    async function finishSale() {
        try {
            await waitForButton(SELECTORS.newSale);
        } catch (error) {
            warn('La venta pudo finalizar, pero no apareció el botón de nueva venta:', error.message);
        }
        dispatchEscape();
    }

    async function runSale(withInvoice) {
        if (saleInProgress) {
            log('Ya hay una venta automática en curso');
            return;
        }

        saleInProgress = true;
        try {
            await clickButton(SELECTORS.basket, 'Canasta abierta');

            if (withInvoice) {
                await clickPrinterAfterContinue();
            }

            await clickButton(SELECTORS.confirmProducts, 'Productos confirmados');
            await clickButton(SELECTORS.calculatorConfirm, 'Pago confirmado');
            await finishSale();
        } catch (error) {
            warn('No se pudo completar la venta automática:', error.message);
        } finally {
            saleInProgress = false;
        }
    }

    async function continueInvoiceSale() {
        if (saleInProgress) {
            log('Ya hay una venta automática en curso');
            return;
        }

        saleInProgress = true;
        try {
            await clickPrinterFromOpenSale();
            await clickButton(SELECTORS.confirmProducts, 'Productos confirmados');
            await clickButton(SELECTORS.calculatorConfirm, 'Pago confirmado');
            await finishSale();
        } catch (error) {
            warn('No se pudo continuar la venta con factura:', error.message);
        } finally {
            saleInProgress = false;
        }
    }

    document.addEventListener('keydown', event => {
        const editing = isEditableTarget(event.target) || isEditableTarget(document.activeElement);
        if (editing || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;

        if (event.code === 'NumpadEnter') {
            event.preventDefault();
            event.stopImmediatePropagation();
            void runSale(false);
            return;
        }

        if (event.code === 'NumpadAdd') {
            event.preventDefault();
            event.stopImmediatePropagation();
            void runSale(true);
            return;
        }

        if (event.key === 'F1' || event.keyCode === 112) {
            event.preventDefault();
            event.stopImmediatePropagation();
            void continueInvoiceSale();
        }
    }, true);

    log('Userscript instalado');
})();
