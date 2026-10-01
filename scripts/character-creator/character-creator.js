import { templatePath } from "../codex/constants.js";
import { chatOutput } from "../utils/chat-output.js";
import { checkReady, setReady, checkStep, completeStep, checkCompleted, setCompleted, reset } from "./progress.js";
import { ClassSelectorApp } from "./select-class.js";
import { AttributeSelectorApp } from "./select-attributes.js";
import { SkillSelectorApp } from "./select-skills.js";
import { rollLoadout } from "./roll-loadout.js";

export async function startCharacterCreation(actor) {
  if (!actor) {
    ui.notifications.error(game.i18n.localize("MoshQoL.Errors.NoActorProvided"));
    return;
  }
  // ✅ Check if character is already completed
  if (checkCompleted(actor)) {
    if (game.user.isGM) {
      const content = await foundry.applications.handlebars.renderTemplate(
        templatePath("character-creator/already-completed-dialog.html"),
        {
          content: game.i18n.format("MoshQoL.CharacterCreator.Dialog.AlreadyCompleted.Content", { actorName: actor.name })
        }
      );
      const resetConfirm = await foundry.applications.api.DialogV2.wait({
        window: { title: game.i18n.localize("MoshQoL.CharacterCreator.Dialog.AlreadyCompleted.Title") },
        content,
        buttons: [
          { label: game.i18n.localize("MoshQoL.Common.Reset"), icon: "fa-solid fa-rotate-left", action: "reset" },
          { label: game.i18n.localize("MoshQoL.Common.Cancel"), icon: "fa-solid fa-xmark", action: "cancel" }
        ],
        default: "cancel"
      });
      if (resetConfirm === "reset") {
        await reset(actor);
      } else {
        return;
      }
    } else {
      ui.notifications.warn(game.i18n.localize("MoshQoL.CharacterCreator.Notifications.AlreadyCompleted"));
      return;
    }
  }

  // ✅ Step 1: Check if actor is marked "ready"
  if (!checkReady(actor)) {
    const content = await foundry.applications.handlebars.renderTemplate(
      templatePath("character-creator/overwrite-warning-dialog.html"),
      {
        noValidData: game.i18n.format("MoshQoL.CharacterCreator.Dialog.Warning.NoValidData", { actorName: actor.name }),
        overwriteRisk: game.i18n.localize("MoshQoL.CharacterCreator.Dialog.Warning.OverwriteRisk"),
        chooseAction: game.i18n.localize("MoshQoL.CharacterCreator.Dialog.Warning.ChooseAction")
      }
    );
  
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize("MoshQoL.CharacterCreator.Dialog.Warning.Title") },
      content,
      buttons: [
        {
          label: game.i18n.localize("MoshQoL.CharacterCreator.Dialog.Warning.Overwrite"),
          icon: "fa-solid fa-triangle-exclamation",
          action: "overwrite"
        },
        {
          label: game.i18n.localize("MoshQoL.CharacterCreator.Dialog.Warning.MarkCompleted"),
          icon: "fa-solid fa-check-circle",
          action: "complete"
        },
        {
          label: game.i18n.localize("MoshQoL.Common.Cancel"),
          icon: "fa-solid fa-xmark",
          action: "cancel"
        }
      ],
      default: "cancel"
    });
  
    if (choice === "complete") {
      await setCompleted(actor, true);
      return;
    }
    // Foundry returns null when the dialog is closed; only explicit overwrite may erase items.
    if (choice !== "overwrite") return;
    await setReady(actor, true);
  }

  // ✅ Step 2: Clean slate – delete items
  if (!checkStep(actor, "preparation")) {
    await actor.update({
      system: {
        class: { value: "", uuid: "" },
        other: { stressdesc: { value: "" }, stress: { value: 2, min: 2 } },
        hits: { value: 0, max: 2 },
        health: { value: "", max: "" },
        credits: { value: "" }
      }
    });
  
    const allItems = actor.items.map(i => i.id);
    if (allItems.length > 0) {
      await actor.deleteEmbeddedDocuments("Item", allItems);
    }
  
    await completeStep(actor, "preparation");
  }

  // ✅ Step 3: Roll stats + saves
  if (!checkStep(actor, "rolledAttributes")) {
    const attributes = ["strength", "speed", "intellect", "combat"];
    const saves = ["sanity", "fear", "body"];

    const rollValue = async (formula) => {
      const roll = new Roll(formula);
      await roll.evaluate();
      return roll.total;
    };

    const rolledAttributes = Object.fromEntries(
      await Promise.all(attributes.map(async attr => [attr, await rollValue("2d10 + 25")]))
    );
    const rolledSaves = Object.fromEntries(
      await Promise.all(saves.map(async save => [save, await rollValue("2d10 + 10")]))
    );

    await actor.update({
      system: {
        stats: {
          ...Object.fromEntries(attributes.map(attr => [attr, { value: rolledAttributes[attr] }])),
          ...Object.fromEntries(saves.map(save => [save, { value: rolledSaves[save] }]))
        }
      }
    });

    const formatCounterColumn = (title, data) => ({
      title,
      items: Object.entries(data).map(([key, value]) => ({
        label: key[0].toUpperCase() + key.slice(1),
        value
      }))
    });

    const statColumns = [
      formatCounterColumn(game.i18n.localize("MoshQoL.CharacterCreator.Chat.StatsRolled.Stats"), rolledAttributes),
      formatCounterColumn(game.i18n.localize("MoshQoL.CharacterCreator.Chat.StatsRolled.Saves"), rolledSaves)
    ];

    await chatOutput({
      actor,
      title: game.i18n.localize("MoshQoL.CharacterCreator.Chat.StatsRolled.Title"),
      subtitle: actor.name,
      blocks: [{ type: "counterColumns", columns: statColumns }],
      icon: "fa-chart-line",
      image: actor.img
    });

    await completeStep(actor, "rolledAttributes");
  }

  // ✅ Step 4: Class selection
  let selectedClass = null;
  if (checkStep(actor, "selectedClass")) {
    const classUUID = actor.system.class.uuid;
    if (classUUID) {
      selectedClass = await fromUuid(classUUID);
      if (!selectedClass) {
        ui.notifications.warn(game.i18n.localize("MoshQoL.CharacterCreator.Notifications.ClassUuidInvalid"));
      }
    } else {
      ui.notifications.warn(game.i18n.localize("MoshQoL.CharacterCreator.Notifications.NoClassUuid"));
    }
  }
  // If nothing was loaded -> selection dialog
  if (!selectedClass) {
    selectedClass = await ClassSelectorApp.wait({ actor });
    if (!selectedClass) return;
    await chatOutput({
      title: game.i18n.localize("MoshQoL.CharacterCreator.Chat.ClassSelected.Title"),
      subtitle: actor.name,
      blocks: [{
        type: "highlight",
        label: game.i18n.format("MoshQoL.CharacterCreator.Chat.ClassSelected.Content", { actorName: actor.name }),
        value: selectedClass.name
      }],
      image: selectedClass?.img || "",
      icon: "fa-user"
    });
    await completeStep(actor, "selectedClass");
  }

  // ✅ Step 5: Attribute selection
  if (!checkStep(actor, "selectedAttributes")) {
    const choices = selectedClass.system?.selected_adjustment?.choose_stat || [];
    if (choices.length > 0) {
      try {
        const adjustments = await AttributeSelectorApp.wait({ actor, attributeChoices: choices });
        if (!adjustments) return;
      } catch (err) {
        console.warn(game.i18n.localize("MoshQoL.CharacterCreator.Notifications.AttributeSelectionAborted"), err);
        return;
      }
    }
    await completeStep(actor, "selectedAttributes");
  }

  // ✅ Step 5b: Roll Potential for psionic classes (Psychic / Emissary)
  if (!checkStep(actor, "rolledPotential")) {
    const psionicClassNames = ["Psychic", "Emissary"];
    if (selectedClass && psionicClassNames.includes(selectedClass.name)) {
      const roll = new Roll("2d10 + 10");
      await roll.evaluate();
      const total = roll.total;

      await actor.update({
        "system.stats.potential.value": total,
        "system.stats.potential.max": total
      });

      await chatOutput({
        actor,
        title: "Potential Rolled",
        subtitle: actor.name,
        icon: "fa-brain",
        blocks: [{ type: "counter", value: total, label: "Potential" }]
      });
    }
    await completeStep(actor, "rolledPotential");
  }

  // ✅ Step 5c: Roll Psionic Abilities for psionic classes (Psychic / Emissary)
  if (!checkStep(actor, "selectedPsionicAbility")) {
    const psionicClassNames = ["Psychic", "Emissary"];
    if (selectedClass && psionicClassNames.includes(selectedClass.name)) {
      const PSIONIC_DISCIPLINES = [
        { name: "Astral Projection", chain: ["NbrnTP3fAbnFbmOH","nKYaXRvj7uff0LYT","H8xIZM1JRcoreogr"] },
        { name: "Clairvoyance Roll", chain: ["Nwwmq6OLkTkx9NIQ","0Wobtqn62tOy4Cqp","IqK3yn9FfcgMXAdx"] },
        { name: "Energy Healing",    chain: ["9G81aSQHqNgAC72q","Fl41sNLjVHWGaub5","2Ztd26fEeVVhDIq2"] },
        { name: "Illusions",         chain: ["AnHTmt9OBGhnuKon","eNo41eoPni6JDWYl","gAACTP9gyv1plBAr"] },
        { name: "Mind Control",      chain: ["p5B1Id9Z850kEnyd","x9qWCA79ISjs8JHU","dKF0j7elKPoh3pKM"] },
        { name: "Photokinesis",      chain: ["zKG5mSoyPstUeC99","enq522wjZRL9OaYs","P6ihgIqLSmNqE40f"] },
        { name: "Pyrokinesis",       chain: ["AraVNqTIAae24HZK","jht3X13npgW2zMj5","18Y2bTu5X1YqWg21"] },
        { name: "Telekinesis",       chain: ["nYCsXoblu17rNy8H","6h8l7qgATtLFxJpR","a5HSUPwePut0Sstz"] },
        { name: "Telepathy",         chain: ["yshA6P3MsHarAJOC","BnD3XkfFNuYUPnmb","pD0ezNmREpOaUVgA"] },
        { name: "Teleportation",     chain: ["k7Gdp0CXP9K63LSF","ZH3UDqpNVGMrerqt","HioRRdzHzmA4KR1V"] },
      ];

      const potential = actor.system.stats.potential?.value ?? 0;
      const numRolls = selectedClass.name === "Psychic" ? Math.floor(potential / 10) : 1;

      const abilityPack = game.packs.get("fvtt_mosh_1e_rwc.items_skills_1e");
      await abilityPack.getIndex();
      const rtPack = game.packs.get("fvtt_mosh_1e_rwc.rolltables_1e");
      const psionicTable = await rtPack.getDocument("xavU07zUHLnnBbuQ");

      const granted = [];
      for (let i = 0; i < numRolls; i++) {
        const drawn = await psionicTable.draw({ displayChat: true });
        const result = drawn.results[0];
        const disc = PSIONIC_DISCIPLINES.find(d => d.chain[0] === result.documentId);
        if (!disc) continue;
        const current = actor.items.find(item => item.type === "ability" && item.name.startsWith(disc.name + " "));
        let grantId, toDelete = [];
        if (!current)                          { grantId = disc.chain[0]; }
        else if (current.name.endsWith(" I"))  { toDelete = [current.id]; grantId = disc.chain[1]; }
        else if (current.name.endsWith(" II")) { toDelete = [current.id]; grantId = disc.chain[2]; }
        else { console.log(`[QoL] ${disc.name} already at Master`); continue; }
        if (toDelete.length) await actor.deleteEmbeddedDocuments("Item", toDelete);
        const doc = await abilityPack.getDocument(grantId);
        await actor.createEmbeddedDocuments("Item", [doc.toObject()]);
        granted.push(doc.name);
      }

      if (granted.length) {
        await chatOutput({
          actor,
          title: "Psionic Abilities Granted",
          subtitle: actor.name,
          icon: "fa-brain",
          blocks: [{ type: "itemList", items: granted.map(n => ({ name: n })), nowrap: true }]
        });
      }
    }
    await completeStep(actor, "selectedPsionicAbility");
  }

  // ✅ Step 6: Roll Health
  if (!checkStep(actor, "rolledHealth")) {
    const formula = `1d10 + 10`;
    const roll = new Roll(formula);
    await roll.evaluate();
  
    const total = roll.total;
    await actor.update({
      "system.health.max": total,
      "system.health.value": total
    });
  
    await chatOutput({
      actor,
      title: game.i18n.localize("MoshQoL.CharacterCreator.Chat.HealthRolled.Title"),
      subtitle: actor.name,
      icon: "fa-heart-pulse",
      blocks: [{ type: "counter", value: total, label: "HP" }]
    });
  
    await completeStep(actor, "rolledHealth");
  }

  // ✅ Step 7: Skill selection
  if (!checkStep(actor, "selectedSkills")) {
    const adjustments = await SkillSelectorApp.wait({ actor, selectedClass });
    if (!adjustments || adjustments.length === 0) return;

    await chatOutput({
      actor,
      title: game.i18n.localize("MoshQoL.CharacterCreator.Chat.SkillsSelected.Title"),
      subtitle: actor.name,
      icon: "fa-sitemap",
      blocks: [{
        type: "itemList",
        items: adjustments,
        nowrap: true
      }]
    });
        
    await completeStep(actor, "selectedSkills");
  }

  // ✅ Step 8: Roll Loadout + Patches + Trinkets + Credits
  if (!checkStep(actor, "rolledLoadout")) {
    const loadoutSuccess = await rollLoadout(actor, selectedClass, {
      rollCredits: true,
      clearItems: false
    });
    if (loadoutSuccess) {
      await completeStep(actor, "rolledLoadout");
    }
  }
     
  // ✅ Final Step: Mark character creation as completed
  await setCompleted(actor, true);

}
