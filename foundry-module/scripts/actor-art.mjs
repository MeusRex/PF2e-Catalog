import {MODULE_ID} from "./catalog.mjs";

export async function confirmArtworkChange(actor, entry, includeToken) {
  const escapedActor = foundry.utils.escapeHTML(actor.name);
  const escapedCaption = foundry.utils.escapeHTML(entry.caption || entry.filename);
  return foundry.applications.api.DialogV2.confirm({
    id: `${MODULE_ID}-confirm-artwork`,
    window: {title: game.i18n.localize("FIC.ConfirmTitle"), width: 500},
    content: `
      <section class="fic-confirm">
        <p>Replace ${escapedActor}'s ${includeToken ? "portrait and prototype-token artwork" : "portrait"}?</p>
        <div class="fic-confirm-images">
          <figure><img src="${actor.img}" alt="Current portrait"><figcaption>Current</figcaption></figure>
          <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
          <figure><img src="${entry.portrait}" alt="${escapedCaption}"><figcaption>New</figcaption></figure>
        </div>
      </section>`,
    modal: true
  });
}

export async function assignArtwork(actor, entry, {includeToken = false} = {}) {
  if (!actor) throw new Error(game.i18n.localize("FIC.NoTarget"));
  if (!actor.canUserModify(game.user, "update")) throw new Error(game.i18n.localize("FIC.PermissionDenied"));
  if (!(await confirmArtworkChange(actor, entry, includeToken))) return false;
  const changes = {img: entry.portrait};
  if (includeToken) changes["prototypeToken.texture.src"] = entry.portrait;
  await actor.update(changes);
  ui.notifications.info(game.i18n.format("FIC.Assigned", {actor: actor.name}));
  return true;
}

export async function createActorFromArtwork(entry) {
  if (!game.user.isGM) throw new Error(game.i18n.localize("FIC.PermissionDenied"));
  const actorTypes = foundry.utils.getDocumentClass("Actor").TYPES ?? Actor.TYPES;
  const configuredType = game.settings.get(MODULE_ID, "actorType");
  const type = actorTypes.includes(configuredType) ? configuredType : actorTypes.find((value) => value !== "base");
  if (!type) throw new Error("No creatable Actor type is available");
  const baseName = entry.caption?.split(/[.!?]/)[0]?.slice(0, 60) || entry.filename.replace(/\.[^.]+$/, "") || "Catalog NPC";
  const collisionCount = game.actors.filter((actor) => actor.name.startsWith(baseName)).length;
  const name = collisionCount ? `${baseName} (${collisionCount + 1})` : baseName;
  const actor = await foundry.utils.getDocumentClass("Actor").create({
    name,
    type,
    img: entry.portrait,
    prototypeToken: {
      name,
      texture: {src: entry.portrait}
    }
  }, {renderSheet: true});
  ui.notifications.info(game.i18n.format("FIC.Created", {actor: actor.name}));
  return actor;
}
