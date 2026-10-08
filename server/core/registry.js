const MODULE_NAME = /^[a-z][a-z0-9_-]{0,40}$/;

function validateModule(mod) {
  if (!mod || typeof mod !== "object") throw new Error("Модуль должен быть объектом");
  if (!MODULE_NAME.test(String(mod.name || ""))) {
    throw new Error(`У модуля некорректное имя: "${mod.name}"`);
  }
  if (typeof mod.setup !== "function") throw new Error(`Модуль "${mod.name}" без функции setup()`);
  if (mod.dependsOn !== undefined && !Array.isArray(mod.dependsOn)) {
    throw new Error(`Модуль "${mod.name}": dependsOn должен быть массивом`);
  }
}

// Dependencies first; the original list order is kept wherever it is free to.
function sortByDependencies(modules) {
  const byName = new Map(modules.map((mod) => [mod.name, mod]));
  const sorted = [];
  const state = new Map();

  function visit(mod, trail) {
    if (state.get(mod.name) === "done") return;
    if (state.get(mod.name) === "visiting") {
      throw new Error(`Циклическая зависимость модулей: ${[...trail, mod.name].join(" -> ")}`);
    }
    state.set(mod.name, "visiting");
    for (const dep of mod.dependsOn || []) {
      const target = byName.get(dep);
      if (target) visit(target, [...trail, mod.name]);
    }
    state.set(mod.name, "done");
    sorted.push(mod);
  }

  modules.forEach((mod) => visit(mod, []));
  return sorted;
}

// Wraps the core for one module: everything it registers is recorded so a
// module whose setup() fails halfway leaves no half-registered routes, tools,
// prompt sections or subscriptions behind.
function createModuleScope(core, mod) {
  const undo = [];
  const routers = [];
  const stopHooks = [];
  const track = (unregister) => {
    if (typeof unregister === "function") undo.push(unregister);
    return unregister;
  };

  const scoped = {
    config: core.config,
    logger: core.logger.child(mod.name),
    storage: core.storage,
    services: {
      register: (name, service) => track(core.services.register(name, service)),
      get: core.services.get,
      require: core.services.require,
      has: core.services.has,
    },
    events: {
      on: (event, handler) => track(core.events.on(event, handler, { name: mod.name })),
      emit: core.events.emit,
    },
    http: {
      route: (register) => routers.push(core.http.createRouter(register)),
      helpers: core.http.helpers,
    },
    ai: {
      chat: core.ai.chat,
      tools: { register: (tool) => track(core.ai.tools.register(tool)) },
      prompt: { addSection: (name, render, options) => track(core.ai.prompt.addSection(name, render, options)) },
      facts: {
        set: (name, fn) => track(core.ai.facts.set(name, fn)),
        get: core.ai.facts.get,
      },
      setFallback: (provider) => track(core.ai.setFallback(provider)),
    },
    files: {
      registerParser: (parser) => track(core.files.registerParser(parser)),
      uploadMiddleware: core.files.uploadMiddleware,
      ingest: core.files.ingest,
      get: core.files.get,
    },
    health: { register: (name, fn) => track(core.health.register(name, fn)) },
    audit: core.audit,
    onStop: (fn) => stopHooks.push(fn),
  };

  return {
    scoped,
    commit() {
      routers.forEach((router) => core.http.mount(router));
      return stopHooks;
    },
    rollback() {
      undo.reverse().forEach((fn) => {
        try {
          fn();
        } catch {
          // Best effort: a failing undo must not hide the original setup error.
        }
      });
      stopHooks.forEach((fn) => {
        try {
          fn();
        } catch {
          // Same as above.
        }
      });
    },
  };
}

async function loadModules(core, modules, { enabled = null } = {}) {
  modules.forEach(validateModule);
  const names = new Set();
  modules.forEach((mod) => {
    if (names.has(mod.name)) throw new Error(`Модуль "${mod.name}" подключён дважды`);
    names.add(mod.name);
  });

  if (enabled) {
    enabled
      .filter((name) => !names.has(name))
      .forEach((name) => core.logger.warn(`ENABLED_MODULES: модуль "${name}" не найден`));
  }

  const selected = enabled ? modules.filter((mod) => enabled.includes(mod.name)) : modules;
  modules
    .filter((mod) => !selected.includes(mod))
    .forEach((mod) => core.logger.info(`Модуль "${mod.name}" выключен через ENABLED_MODULES`));

  const loaded = [];
  const failed = [];
  const stopHooks = [];

  for (const mod of sortByDependencies(selected)) {
    const missing = (mod.dependsOn || []).filter((dep) => !loaded.includes(dep));
    if (missing.length) {
      const message = `Модуль "${mod.name}" не запущен: нет модулей ${missing.join(", ")}`;
      if (!mod.optional) throw new Error(message);
      core.logger.error(message);
      failed.push(mod.name);
      continue;
    }

    const scope = createModuleScope(core, mod);
    try {
      await mod.setup(scope.scoped);
      stopHooks.push(...scope.commit());
      loaded.push(mod.name);
    } catch (err) {
      scope.rollback();
      if (!mod.optional) {
        err.message = `Модуль "${mod.name}" не запустился: ${err.message}`;
        throw err;
      }
      core.logger.error(`Модуль "${mod.name}" не запустился, сайт работает без него:`, err);
      failed.push(mod.name);
    }
  }

  return { loaded, failed, stopHooks };
}

module.exports = { loadModules, sortByDependencies };
