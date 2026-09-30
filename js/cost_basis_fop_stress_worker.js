/*
 * Dedicated worker of the FOP stress view (CODE PLAN/COST_BASIS_FOP_STRESS_CONTRACT.md §9).
 * Its dependencies are the exact versioned script URLs the page loaded, so the
 * worker never runs another version of the core than the page shows. It
 * answers {generation, key, result} and holds no client: nothing is sent.
 */
if (typeof document === 'undefined') self.onmessage = function (event) {
    const { generation, key, dependencies, input, params } = event.data;
    let result;
    try {
        if (!self.OptionComboCostBasisFopStress) importScripts(...dependencies);
        result = self.OptionComboCostBasisFopStress.run(input, params);
    } catch (error) {
        result = { version: 'fop-stress-v1', available: false, empty: false, reasons: ['stress_failed'],
            message: String((error && error.message) || error) };
    }
    self.postMessage({ generation, key, result });
};
