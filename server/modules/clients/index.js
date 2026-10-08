const { cleanText } = require("../../core/utils/text");
const { createClientsService } = require("./service");

module.exports = {
  name: "clients",
  dependsOn: ["orders"],
  optional: true,
  setup(core) {
    const repo = core.storage.repository("clients");
    repo.list();
    const orders = core.services.require("orders");
    const service = createClientsService({ repo, listOrders: orders.list });

    core.services.register("clients", service);

    // A missing card is recreated from orders the next time the client list is opened.
    core.events.on("order.created", ({ order }) => service.upsertFromOrder(order, { isNewOrder: true }));
    core.events.on("order.updated", ({ order, contactChanged, previousContact }) => {
      if (contactChanged) return service.upsertFromOrder(order, { previousContact });
    });

    core.http.route((router, { auth, asyncHandler }) => {
      router.get(
        "/api/clients",
        auth,
        asyncHandler(async (_req, res) => {
          res.json(await service.buildList());
        })
      );

      router.patch(
        "/api/clients/:id",
        auth,
        asyncHandler(async (req, res) => {
          const body = req.body || {};
          const result = await repo.update(req.params.id, (client, tx) => {
            const fail = (status, error) => {
              tx.skipWrite();
              return { status, body: { error } };
            };
            if (!client) return fail(404, "Клиент не найден");
            // Two open admin tabs both loaded the same card. The first save wins;
            // the second must not overwrite its note with a stale copy.
            if (
              body.updatedAt !== undefined &&
              client.updatedAt &&
              String(body.updatedAt) !== String(client.updatedAt)
            ) {
              return fail(409, "Карточку уже изменили. Список обновлён — проверьте заметку и сохраните ещё раз.");
            }

            const next = {};
            if (body.note !== undefined) next.note = cleanText(body.note, 2000);
            if (body.name !== undefined) {
              const name = cleanText(body.name, 80);
              if (!name) return fail(400, "Имя не может быть пустым");
              next.name = name;
            }
            if (body.hidden !== undefined) next.hidden = Boolean(body.hidden);
            Object.assign(client, next, { updatedAt: new Date().toISOString() });
            return { status: 200, body: client };
          });
          res.status(result.status).json(result.body);
        })
      );
    });
  },
};
