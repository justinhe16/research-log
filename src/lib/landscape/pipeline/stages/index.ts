/*
 * Registers every real stage implementation with the stage registry. Imported
 * (dynamically) by `loadStages()`; never import this from tests.
 */
import { registerStages } from "../stage-registry";
import { discoverStages } from "./discover";
import { structureStages } from "./structure";

registerStages(discoverStages);
registerStages(structureStages);
