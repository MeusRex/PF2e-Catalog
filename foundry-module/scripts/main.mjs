import {loadCatalog, MODULE_ID} from "./catalog.mjs";
import {FantasyGalleryApplication} from "./gallery.mjs";
import {registerSettings} from "./settings.mjs";

Hooks.once("init", () => {
  registerSettings();
  const module = game.modules.get(MODULE_ID);
  module.api = {
    application: null,
    open: (actor = null) => {
      const application = module.api.application;
      if (!application) return ui.notifications.warn(game.i18n.localize("FIC.NoCatalog"));
      if (!application.userHasAccess) return ui.notifications.error(game.i18n.localize("FIC.PermissionDenied"));
      application.setTarget(actor).render({force: true});
    }
  };
});

Hooks.once("ready", async () => {
  const module = game.modules.get(MODULE_ID);
  try {
    const catalog = await loadCatalog();
    module.api.application = new FantasyGalleryApplication(catalog);
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to load catalog`, error);
    if (game.user.isGM) ui.notifications.warn(game.i18n.localize("FIC.NoCatalog"));
  }
});

Hooks.on("renderActorDirectory", (app, _element, _context, options) => {
  const application = game.modules.get(MODULE_ID)?.api?.application;
  if (!application?.userHasAccess || !options.parts.includes("footer")) return;
  if (app.element.querySelector(`#${MODULE_ID}-button`)) return;
  const button = document.createElement("button");
  button.id = `${MODULE_ID}-button`;
  button.innerHTML = `<i class="fa-solid fa-images fa-fw"></i><span>${game.i18n.localize("FIC.Open")}</span>`;
  button.addEventListener("click", () => game.modules.get(MODULE_ID).api.open());
  app.element.querySelector("footer.directory-footer")?.append(button);
});

Hooks.on("getActorSheetHeaderButtons", (app, buttons) => {
  const application = game.modules.get(MODULE_ID)?.api?.application;
  if (!application?.userHasAccess || !game.settings.get(MODULE_ID, "headerButton")) return;
  buttons.unshift({
    class: `${MODULE_ID}-open`,
    icon: "fa-solid fa-images",
    label: game.i18n.localize("FIC.Open"),
    onclick: () => game.modules.get(MODULE_ID).api.open(app.actor)
  });
});

Hooks.on("getHeaderControlsActorSheetV2", (app, controls) => {
  const application = game.modules.get(MODULE_ID)?.api?.application;
  controls.unshift({
    icon: "fa-solid fa-images",
    label: game.i18n.localize("FIC.Open"),
    visible: Boolean(application?.userHasAccess && game.settings.get(MODULE_ID, "headerButton")),
    onClick: () => game.modules.get(MODULE_ID).api.open(app.actor)
  });
});
