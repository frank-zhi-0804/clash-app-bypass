(function () {
  const previousMain = main;
  main = function (config, ...args) {
    const result = previousMain(config, ...args);
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.then === 'function') {
      throw new Error('Clash App Bypass: original main must return a configuration object synchronously');
    }
    const directRules = __VERGE_DIRECT_RULES__;
    const routing = __VERGE_DIRECT_ROUTING__;
    const originalRules = Array.isArray(result.rules) ? result.rules : [];
    if (routing.mode === 'proxy') {
      const group = routing.proxyGroup;
      if (typeof group !== 'string' || !group.trim() || /[,\r\n]/.test(group) || ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'].includes(group.toUpperCase())) {
        throw new Error('Clash App Bypass: choose a valid proxy group');
      }
      if (group !== 'GLOBAL' && !(Array.isArray(result['proxy-groups']) && result['proxy-groups'].some(item => item.name === group))) {
        throw new Error('Clash App Bypass: selected proxy group no longer exists: ' + group);
      }
      result.rules = [...directRules, 'MATCH,' + group];
    } else if (routing.mode === 'subscription') {
      result.rules = [...directRules, ...originalRules.filter(rule => !directRules.includes(rule))];
    } else {
      throw new Error('Clash App Bypass: invalid routing mode');
    }
    result['find-process-mode'] = 'always';
    return result;
  };
})();
