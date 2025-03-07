// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { PageConfig } from '@jupyterlab/coreutils';
import { Base64ModelFactory } from '@jupyterlab/docregistry';
import { IRenderMime } from '@jupyterlab/rendermime-interfaces';
import { ServiceManager } from '@jupyterlab/services';
import { PromiseDelegate, Token } from '@lumino/coreutils';
import { JupyterFrontEnd, JupyterFrontEndPlugin } from './frontend';
import { createRendermimePlugins } from './mimerenderers';
import { ILabShell, LabShell } from './shell';
import { LabStatus } from './status';

/**
 * JupyterLab is the main application class. It is instantiated once and shared.
 */
export class JupyterLab extends JupyterFrontEnd<ILabShell> {
  /**
   * Construct a new JupyterLab object.
   */
  constructor(options: JupyterLab.IOptions = { shell: new LabShell() }) {
    super({
      ...options,
      shell: options.shell || new LabShell(),
      serviceManager:
        options.serviceManager ||
        new ServiceManager({
          standby: () => {
            return !this._info.isConnected || 'when-hidden';
          }
        })
    });

    // Create an IInfo dictionary from the options to override the defaults.
    const info = Object.keys(JupyterLab.defaultInfo).reduce((acc, val) => {
      if (val in options) {
        (acc as any)[val] = JSON.parse(JSON.stringify((options as any)[val]));
      }
      return acc;
    }, {} as Partial<JupyterLab.IInfo>);

    // Populate application info.
    this._info = { ...JupyterLab.defaultInfo, ...info };

    this.restored = this.shell.restored
      .then(async () => {
        const activated: Promise<void | void[]>[] = [];
        const deferred = this.activateDeferredPlugins().catch(error => {
          console.error('Error when activating deferred plugins\n:', error);
        });
        activated.push(deferred);
        if (this._info.deferred) {
          const customizedDeferred = Promise.all(
            this._info.deferred.matches.map(pluginID =>
              this.activatePlugin(pluginID)
            )
          ).catch(error => {
            console.error(
              'Error when activating customized list of deferred plugins:\n',
              error
            );
          });
          activated.push(customizedDeferred);
        }
        Promise.all(activated)
          .then(() => {
            this._allPluginsActivated.resolve();
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);

    // Populate application paths override the defaults if necessary.
    const defaultURLs = JupyterLab.defaultPaths.urls;
    const defaultDirs = JupyterLab.defaultPaths.directories;
    const optionURLs = (options.paths && options.paths.urls) || {};
    const optionDirs = (options.paths && options.paths.directories) || {};

    this._paths = {
      urls: Object.keys(defaultURLs).reduce((acc, key) => {
        if (key in optionURLs) {
          const value = (optionURLs as any)[key];
          (acc as any)[key] = value;
        } else {
          (acc as any)[key] = (defaultURLs as any)[key];
        }
        return acc;
      }, {}),
      directories: Object.keys(JupyterLab.defaultPaths.directories).reduce(
        (acc, key) => {
          if (key in optionDirs) {
            const value = (optionDirs as any)[key];
            (acc as any)[key] = value;
          } else {
            (acc as any)[key] = (defaultDirs as any)[key];
          }
          return acc;
        },
        {}
      )
    } as JupyterFrontEnd.IPaths;

    if (this._info.devMode) {
      this.shell.addClass('jp-mod-devMode');
    }

    // Add initial model factory.
    this.docRegistry.addModelFactory(new Base64ModelFactory());

    if (options.mimeExtensions) {
      for (const plugin of createRendermimePlugins(options.mimeExtensions)) {
        this.registerPlugin(plugin);
      }
    }
  }

  /**
   * The name of the JupyterLab application.
   */
  readonly name = PageConfig.getOption('appName') || 'JupyterLab';

  /**
   * A namespace/prefix plugins may use to denote their provenance.
   */
  readonly namespace = PageConfig.getOption('appNamespace') || this.name;

  /**
   * A list of all errors encountered when registering plugins.
   */
  readonly registerPluginErrors: Array<Error> = [];

  /**
   * Promise that resolves when state is first restored, returning layout
   * description.
   */
  readonly restored: Promise<void>;

  /**
   * The application busy and dirty status signals and flags.
   */
  readonly status = new LabStatus(this);

  /**
   * The version of the JupyterLab application.
   */
  readonly version = PageConfig.getOption('appVersion') || 'unknown';

  /**
   * The JupyterLab application information dictionary.
   */
  get info(): JupyterLab.IInfo {
    return this._info;
  }

  /**
   * The JupyterLab application paths dictionary.
   */
  get paths(): JupyterFrontEnd.IPaths {
    return this._paths;
  }

  /**
   * Promise that resolves when all the plugins are activated, including the deferred.
   */
  get allPluginsActivated(): Promise<void> {
    return this._allPluginsActivated.promise;
  }
  /**
   * Register plugins from a plugin module.
   *
   * @param mod - The plugin module to register.
   */
  registerPluginModule(mod: JupyterLab.IPluginModule): void {
    let data = mod.default;
    // Handle commonjs exports.
    if (!mod.hasOwnProperty('__esModule')) {
      data = mod as any;
    }
    if (!Array.isArray(data)) {
      data = [data];
    }
    data.forEach(item => {
      try {
        this.registerPlugin(item);
      } catch (error) {
        this.registerPluginErrors.push(error);
      }
    });
  }

  /**
   * Register the plugins from multiple plugin modules.
   *
   * @param mods - The plugin modules to register.
   */
  registerPluginModules(mods: JupyterLab.IPluginModule[]): void {
    mods.forEach(mod => {
      this.registerPluginModule(mod);
    });
  }

  /**
   * Override keydown handling to prevent command shortcuts from preventing user input.
   *
   * This introduces a slight delay to the command invocation, but no delay to user input.
   */
  protected evtKeydown(event: KeyboardEvent): void {
    // Process select keys which may call `preventDefault()` immediately
    if (
      ['Tab', 'ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(
        event.key
      )
    ) {
      return this.commands.processKeydownEvent(event);
    }
    // Process remaining events conditionally, depending on whether they would lead to text insertion
    const causesInputPromise = Promise.race([
      new Promise(resolve => {
        if (!event.target) {
          return resolve(false);
        }
        event.target.addEventListener(
          'beforeinput',
          (inputEvent: InputEvent) => {
            switch (inputEvent.inputType) {
              case 'historyUndo':
              case 'historyRedo': {
                if (
                  inputEvent.target instanceof Element &&
                  inputEvent.target.closest('[data-jp-undoer]')
                ) {
                  // Allow to use custom undo/redo bindings on `jpUndoer`s
                  inputEvent.preventDefault();
                  return resolve(false);
                }
                break;
              }
              case 'insertLineBreak': {
                if (
                  inputEvent.target instanceof Element &&
                  inputEvent.target.closest('.jp-Cell')
                ) {
                  // Allow to override the default action of Shift + Enter on cells as this is used for cell execution
                  inputEvent.preventDefault();
                  return resolve(false);
                }
                break;
              }
            }
            return resolve(true);
          },
          { once: true }
        );
      }),
      new Promise(resolve => {
        setTimeout(() => resolve(false), Private.INPUT_GUARD_TIMEOUT);
      })
    ]);
    causesInputPromise
      .then(willCauseInput => {
        if (!willCauseInput) {
          this.commands.processKeydownEvent(event);
        }
      })
      .catch(console.warn);
  }

  private _info: JupyterLab.IInfo = JupyterLab.defaultInfo;
  private _paths: JupyterFrontEnd.IPaths;
  private _allPluginsActivated = new PromiseDelegate<void>();
}

/**
 * The namespace for `JupyterLab` class statics.
 */
export namespace JupyterLab {
  /**
   * The options used to initialize a JupyterLab object.
   */
  export interface IOptions
    extends Partial<JupyterFrontEnd.IOptions<ILabShell>>,
      Partial<IInfo> {
    paths?: Partial<JupyterFrontEnd.IPaths>;
  }

  /**
   * The layout restorer token.
   */
  export const IInfo = new Token<IInfo>(
    '@jupyterlab/application:IInfo',
    'A service providing metadata about the current application, including disabled extensions and whether dev mode is enabled.'
  );

  /**
   * The information about a JupyterLab application.
   */
  export interface IInfo {
    /**
     * Whether the application is in dev mode.
     */
    readonly devMode: boolean;

    /**
     * The collection of deferred extension patterns and matched extensions.
     */
    readonly deferred: { patterns: string[]; matches: string[] };

    /**
     * The collection of disabled extension patterns and matched extensions.
     */
    readonly disabled: { patterns: string[]; matches: string[] };

    /**
     * The mime renderer extensions.
     */
    readonly mimeExtensions: IRenderMime.IExtensionModule[];

    /**
     * The information about available plugins.
     */
    readonly availablePlugins: IPluginInfo[];

    /**
     * Whether files are cached on the server.
     */
    readonly filesCached: boolean;

    /**
     * Every periodic network polling should be paused while this is set
     * to `false`. Extensions should use this value to decide whether to proceed
     * with the polling.
     * The extensions may also set this value to `false` if there is no need to
     * fetch anything from the server backend basing on some conditions
     * (e.g. when an error message dialog is displayed).
     * At the same time, the extensions are responsible for setting this value
     * back to `true`.
     */
    isConnected: boolean;
  }

  /*
   * A read-only subset of the `Token`.
   */
  interface IToken extends Readonly<Pick<Token<any>, 'name' | 'description'>> {
    // no-op
  }

  /**
   * A readonly subset of lumino plugin bundle (excluding activation function,
   * service, and state information, and runtime token details).
   */
  interface ILuminoPluginData
    extends Readonly<
      Pick<JupyterFrontEndPlugin<void>, 'id' | 'description' | 'autoStart'>
    > {
    /**
     * The types of required services for the plugin, or `[]`.
     */
    readonly requires: IToken[];

    /**
     * The types of optional services for the the plugin, or `[]`.
     */
    readonly optional: IToken[];

    /**
     * The type of service provided by the plugin, or `null`.
     */
    readonly provides: IToken | null;
  }

  /**
   * A subset of plugin bundle enriched with JupyterLab extension metadata.
   */
  export interface IPluginInfo extends ILuminoPluginData {
    /**
     * The name of the extension which provides the plugin.
     */
    extension: string;
    /**
     * Whether the plugin is enabled.
     */
    enabled: boolean;
  }

  /**
   * The default JupyterLab application info.
   */
  export const defaultInfo: IInfo = {
    devMode: PageConfig.getOption('devMode').toLowerCase() === 'true',
    deferred: { patterns: [], matches: [] },
    disabled: { patterns: [], matches: [] },
    mimeExtensions: [],
    availablePlugins: [],
    filesCached: PageConfig.getOption('cacheFiles').toLowerCase() === 'true',
    isConnected: true
  };

  /**
   * The default JupyterLab application paths.
   */
  export const defaultPaths: JupyterFrontEnd.IPaths = {
    urls: {
      base: PageConfig.getOption('baseUrl'),
      notFound: PageConfig.getOption('notFoundUrl'),
      app: PageConfig.getOption('appUrl'),
      doc: PageConfig.getOption('docUrl'),
      static: PageConfig.getOption('staticUrl'),
      settings: PageConfig.getOption('settingsUrl'),
      themes: PageConfig.getOption('themesUrl'),
      translations: PageConfig.getOption('translationsApiUrl'),
      hubHost: PageConfig.getOption('hubHost') || undefined,
      hubPrefix: PageConfig.getOption('hubPrefix') || undefined,
      hubUser: PageConfig.getOption('hubUser') || undefined,
      hubServerName: PageConfig.getOption('hubServerName') || undefined
    },
    directories: {
      appSettings: PageConfig.getOption('appSettingsDir'),
      schemas: PageConfig.getOption('schemasDir'),
      static: PageConfig.getOption('staticDir'),
      templates: PageConfig.getOption('templatesDir'),
      themes: PageConfig.getOption('themesDir'),
      userSettings: PageConfig.getOption('userSettingsDir'),
      serverRoot: PageConfig.getOption('serverRoot'),
      workspaces: PageConfig.getOption('workspacesDir')
    }
  };

  /**
   * The interface for a module that exports a plugin or plugins as
   * the default value.
   */
  export interface IPluginModule {
    /**
     * The default export.
     */
    default:
      | JupyterFrontEndPlugin<any, any, any>
      | JupyterFrontEndPlugin<any, any, any>[];
  }
}

/**
 * A namespace for module-private functionality.
 */
namespace Private {
  /**
   * The delay for invoking a command introduced by user input guard.
   * Decreasing this value may lead to commands incorrectly triggering
   * on user input. Increasing this value will lead to longer delay for
   * command invocation. Note that user input is never delayed.
   *
   * The value represents the number in milliseconds.
   */
  export const INPUT_GUARD_TIMEOUT = 10;
}
