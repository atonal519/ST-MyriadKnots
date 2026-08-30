import { createBackendClient } from './src/backend-client.js';
import { createDemoController } from './src/demo-controller.js';
import { bindRerunEvents, bindStableFloorEvents, createRerunOrchestrator, registerIntegration, startInitialRun } from './src/integration-port.js';
import { createFormalAdapter } from './src/formal-storage.js';
import { createRouteSourceAdapter } from './src/route-source.js';
import { user_avatar } from '../../../personas.js';
import { bootstrap } from './dist/index.js';
import { createCRegistryAdapter, mapPeopleError } from './src/c-registry.js';
import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { createSettingsStore } from './src/settings.js';
import { createApiResolver, createApiTools, createPeopleTaskRouter } from './src/api-routing.js';
import { createCompactApiClient } from './src/compact-api-client.js';
import { createPluginGate } from './src/plugin-gate.js';
import { createRuntimeRunner } from './src/runtime-runner.js';
import { createStableFloorAdapter } from './src/stable-floor-storage.js';
import { createFoundationAwarePeopleAdapter, createPeopleFoundationAdapter } from './src/people-foundation.js';
import { createInitialRelationGenerationAdapter } from './src/initial-relation-generation.js';
import { createPendingReviewAdapter } from './src/pending-review.js';
import { createBaiBaiBookMemoryAdapter } from './src/baibai-book-memory.js';

const ctx = () => globalThis.Luker?.getContext?.();
const client = createBackendClient({ headers: () => ctx()?.getRequestHeaders?.() ?? {} });
const settings = createSettingsStore({ extensionSettings: extension_settings, save: saveSettingsDebounced });
const compactClient = createCompactApiClient({ headers: () => ctx()?.getRequestHeaders?.() ?? {} });
const apiResolver = createApiResolver({ settings });
const peopleTaskRouter = createPeopleTaskRouter({ resolver: apiResolver, compactClient, fallbackGenerateTask: options => contextProvider().generateTask(options), isEnabled: settings.isEnabled });
const apiTools = createApiTools({ resolver: apiResolver, compactClient, isEnabled: settings.isEnabled });
const controller = createDemoController({ client, contextProvider: () => ({ ...ctx(), userAvatar: user_avatar }) });
const contextProvider = () => ({ ...ctx(), userAvatar: user_avatar });
const routeSource = createRouteSourceAdapter({ contextProvider });
const formal = createFormalAdapter({ client, contextProvider, routeSource });
const stableFloors = createStableFloorAdapter({ client, contextProvider });
const peopleFoundation = createPeopleFoundationAdapter({ client, contextProvider });
const memorySource = createBaiBaiBookMemoryAdapter();
const initialRelations = createInitialRelationGenerationAdapter({ client, contextProvider, routeSource, generateRelationTask: peopleTaskRouter.generatePeopleTask, memorySource, isEnabled: settings.isEnabled });
const pendingReviews = createPendingReviewAdapter({ client, contextProvider, isEnabled: settings.isEnabled });
const peopleRegistry = createCRegistryAdapter({ client, contextProvider, routeSource, formal, generatePeopleTask: peopleTaskRouter.generatePeopleTask, isEnabled: settings.isEnabled });
const people = createFoundationAwarePeopleAdapter({ people: peopleRegistry, foundation: peopleFoundation, stableFloors });
const orchestrator = createRerunOrchestrator({ demo: controller, formal, isEnabled: settings.isEnabled });
const disabledState = () => ({ status: 'disabled', pluginEnabled: false });
let ui;
const runtime = createRuntimeRunner({
  isEnabled: settings.isEnabled, orchestrator, people, stableFloors, peopleFoundation, initialRelations, disabledState, mapError: mapPeopleError,
  setState: state => ui?.setState(state),
  invalidateDependencies: () => { peopleTaskRouter.abortAll(); apiTools.abortAll(); people.invalidate(); stableFloors.invalidate(); peopleFoundation.invalidate(); initialRelations.invalidate(); pendingReviews.invalidate(); orchestrator.invalidate(); },
});
const { run, invalidate } = runtime;
const pluginGate = createPluginGate({ initiallyEnabled: settings.isEnabled(), invalidate, run, disabledState, setUiEnabled: enabled => { ui?.setEnabled(enabled); if (!enabled) ui?.setState(disabledState()); } });
const onPluginEnabledChange = enabled => pluginGate.setEnabled(enabled);
ui = bootstrap({ formal, people, settings, apiTools, loadState: run, initialRelations, reviewActions: pendingReviews, onPluginEnabledChange });
const gated = (operation, fallback = disabledState) => (...args) => settings.isEnabled() ? operation(...args) : Promise.resolve(fallback());
registerIntegration({
  runDemo: run,
  getState: () => settings.isEnabled() ? controller.getState() : disabledState(),
  getFormalState: gated(formal.getFormalState),
  initializeCard: gated(formal.initializeCard),
  getPeople: gated(people.getPeople),
  identifyPeople: gated(people.identify),
  selectPerson: gated(people.selectPerson),
  unselectPerson: gated(people.unselectPerson),
  shelvePerson: gated(people.shelve),
  restorePerson: gated(people.restore),
  refreshStableFloors: gated(stableFloors.refresh),
  getStableFloorState: () => settings.isEnabled() ? stableFloors.getCommittedState() : disabledState(),
  initializePeopleFoundation: gated(peopleFoundation.initialize),
  restorePeopleFoundation: gated(peopleFoundation.restore),
  getPeopleFoundationState: () => settings.isEnabled() ? peopleFoundation.getState() : disabledState(),
  startInitialRelationGeneration: gated(initialRelations.start),
  resumeInitialRelationGeneration: gated(initialRelations.resume),
  getInitialRelationGenerationState: () => settings.isEnabled() ? initialRelations.getState() : disabledState(),
  adoptCurrentInitialRelationSources: gated(initialRelations.adoptCurrentSources),
  extractSelectedCharacterBasicInfo: gated(initialRelations.extractBasicInfo),
  saveSelectedCharacterBasicField: gated(initialRelations.saveBasicField),
  updateSelectedCharacterDynamicFields: gated(initialRelations.updateDynamicFields),
  saveSelectedCharacterDynamicField: gated(initialRelations.saveDynamicField),
  cancelInitialRelationGeneration: () => { initialRelations.cancel(); return settings.isEnabled() ? { status: 'cancelled' } : disabledState(); },
  resolvePendingReview: gated(pendingReviews.resolvePendingReview),
});
const host = ctx();
bindRerunEvents({ eventSource: host?.eventSource, eventTypes: host?.eventTypes, controller: { invalidate, run }, isEnabled: settings.isEnabled });
bindStableFloorEvents({ eventSource: host?.eventSource, eventTypes: host?.eventTypes, controller: { invalidate: stableFloors.invalidate, run: stableFloors.refresh }, isEnabled: settings.isEnabled });
startInitialRun({ run }, console, settings.isEnabled);
