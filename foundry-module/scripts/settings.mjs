import {MODULE_ID} from "./catalog.mjs";

export function registerSettings() {
  game.settings.register(MODULE_ID, "galleryAccess", {
    name: "FIC.Settings.Access.Name",
    hint: "FIC.Settings.Access.Hint",
    scope: "world",
    config: true,
    type: Number,
    choices: {
      1: "USER.RolePlayer",
      2: "USER.RoleTrusted",
      3: "USER.RoleAssistant",
      4: "USER.RoleGamemaster"
    },
    default: CONST.USER_ROLES.ASSISTANT
  });

  game.settings.register(MODULE_ID, "headerButton", {
    name: "FIC.Settings.Header.Name",
    hint: "FIC.Settings.Header.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "actorType", {
    name: "FIC.Settings.ActorType.Name",
    hint: "FIC.Settings.ActorType.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "npc"
  });

  game.settings.register(MODULE_ID, "catalogPath", {
    name: "FIC.Settings.CatalogPath.Name",
    hint: "FIC.Settings.CatalogPath.Hint",
    scope: "world",
    config: true,
    type: String,
    default: `modules/${MODULE_ID}/generated/catalog.json`
  });
}
