(function () {
  const previousMain = main;
  main = function (config, ...args) {
    const result = previousMain(config, ...args);
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.then === 'function') {
      throw new Error('Clash App Bypass: original main must return a configuration object synchronously');
    }
    const directRules = __VERGE_DIRECT_RULES__;
    const originalRules = Array.isArray(result.rules) ? result.rules : [];
    result.rules = [...directRules, ...originalRules.filter(rule => !directRules.includes(rule))];
    result['find-process-mode'] = 'always';
    return result;
  };
})();
