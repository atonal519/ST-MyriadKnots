import { createBackendClient } from './src/backend-client.js';
import { createDemoController } from './src/demo-controller.js';
import { bindRerunEvents, createRerunOrchestrator, registerIntegration, startInitialRun } from './src/integration-port.js';
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
const people = createCRegistryAdapter({ client, contextProvider, routeSource, formal, generatePeopleTask: peopleTaskRouter.generatePeopleTask, isEnabled: settings.isEnabled });
const orchestrator = createRerunOrchestrator({ demo: controller, formal, isEnabled: settings.isEnabled });
const disabledState = () => ({ status: 'disabled', pluginEnabled: false });
let ui;
const runtime = createRuntimeRunner({
  isEnabled: settings.isEnabled, orchestrator, people, disabledState, mapError: mapPeopleError,
  setState: state => ui?.setState(state),
  invalidateDependencies: () => { peopleTaskRouter.abortAll(); apiTools.abortAll(); people.invalidate(); orchestrator.invalidate(); },
});
const { run, invalidate } = runtime;
const pluginGate = createPluginGate({ initiallyEnabled: settings.isEnabled(), invalidate, run, disabledState, setUiEnabled: enabled => { ui?.setEnabled(enabled); if (!enabled) ui?.setState(disabledState()); } });
const onPluginEnabledChange = enabled => pluginGate.setEnabled(enabled);
ui = bootstrap({ contextProvider: () => ({ ...ctx(), userAvatar: user_avatar }), formal, people, settings, apiTools, onPluginEnabledChange });
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
});
const host = ctx();
bindRerunEvents({ eventSource: host?.eventSource, eventTypes: host?.eventTypes, controller: { invalidate, run }, isEnabled: settings.isEnabled });
startInitialRun({ run }, console, settings.isEnabled);
