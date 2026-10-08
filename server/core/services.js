function createServiceRegistry() {
  const services = new Map();

  return {
    register(name, service) {
      if (services.has(name)) throw new Error(`Сервис "${name}" уже зарегистрирован`);
      services.set(name, service);
      return () => {
        if (services.get(name) === service) services.delete(name);
      };
    },
    get: (name) => services.get(name),
    require(name) {
      const service = services.get(name);
      if (!service) throw new Error(`Сервис "${name}" не найден — модуль не подключён`);
      return service;
    },
    has: (name) => services.has(name),
  };
}

module.exports = { createServiceRegistry };
