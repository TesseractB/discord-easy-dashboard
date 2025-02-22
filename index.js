const express = require("express");
const session = require("express-session");
const favicon = require("serve-favicon");
const { existsSync, readdirSync } = require("fs");
const { join } = require("path");
const ejs = require("ejs");
const { EventEmitter } = require("events");
const { Permissions } = require('discord.js');

class Dashboard extends EventEmitter {
    constructor(client, options) {
        super();

        if (+process.versions.node.split(".")[0] < 16)
            throw new Error("Discord-easy-dashboard only supports node-v16+");

        if (!client) throw new Error("Client is a required parameter.");
        this.client = client;

        this.app = express();

        this.details = {
            name: options?.name || client?.user?.username || null,
            description: options?.description || null,
            faviconPath: options?.faviconPath || null,
            serverUrl: options?.serverUrl || null,
            inviteUrl: options?.inviteUrl || null,
        };

        if (!client.isReady())
            client.on(
                "ready",
                () =>
                    (this.details.name =
                        this.details.name === null ? this.client.user.username : this.details.name)
            );

        this._commands = [];
        this._settings = [];

        this.config = {
            baseUrl: options?.baseUrl || "http://localhost",
            port: options?.port || 3000,
            noPortIncallbackUrl: options?.noPortIncallbackUrl || false,
            secret: options?.secret,
            logRequests: options?.logRequests || false,
            injectCSS: options?.injectCSS || null,
            theme: this._getTheme(options?.theme),
            permissions: options?.permissions || [Permissions.FLAGS.MANAGE_GUILD],
            session: options?.session || null,
        };

        if (!this.config.secret)
            console.warn(
                "Without the client.secret parameter, some features of discord-easy-dashboard will be disabled, like Discord authentification or guild settings..."
            );

        this._setup();
        this._checkRoutes();
        this._loadRoutes();
        this._start();
    }

    _getTheme(theme) {
        if(!theme) require(join(__dirname, "themes", "light"));
        if(typeof theme === 'object') return theme;
        if(!existsSync(join(__dirname, "themes", theme))) throw new Error(`Theme ${theme} not found!`);
        return require(join(__dirname, "themes", theme));
    }

    _setup() {
        this.app.set("port", this.config.port || 3000);
        this.app.set("views", join(__dirname, "views"));
        this.app.set("view engine", "ejs");
        this.app.engine("ejs", async (path, data, cb) => {
            try {
                let html = await ejs.renderFile(path, data, { async: true });
                cb(null, html);
            } catch (e) {
                cb(e, "");
            }
        });
        if (this.details.faviconPath) this.app.use(favicon(this.details.faviconPath));
        this.app.use(express.static(join(__dirname, "public")));
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: false }));

        if (this.config.logRequests) {
            const morgan = require("morgan");
            this.app.use(morgan("dev"));
        }

        if(this.config.session) {
            this.app.use(session(this.config.session));
        }
        else {
            this.app.use(
                session({
                    secret: `discord-easy-dashboard-${Date.now()}-${this.client.id}-${Math.random().toString(36)}`,
                    resave: false,
                    saveUninitialized: false,
                })
            );
        }
        
        this.app.use((req, res, next) => {
            res.setHeader("Access-Control-Allow-Headers", "X-Requested-With,content-type");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
            res.setHeader("Access-Control-Allow-Credentials", true);

            req.user = req.session.user;
            req.dashboardConfig = this.config;
            req.dashboardDetails = this.details;
            req.dashboardCommands = this._commands;
            req.client = this.client;
            req.dashboardEmit = (...args) => this.emit(...args);
            req.dashboardSettings = this._settings;

            next();
        });
    }
    _loadRoutes() {
        const files = readdirSync(join(__dirname, "routes"));
        const routes = files.filter((c) => c.split(".").pop() === "js");
        if (files.length === 0 || routes.length === 0) throw new Error("No routes were found!");
        for (let i = 0; i < routes.length; i++) {
            if (
                (!this.config.secret &&
                    ["auth.js", "manage.js", "selector.js"].includes(routes[i])) ||
                routes[i] === "custom.js"
            )
                continue;
            const route = require(`./routes/${routes[i]}`);
            this.app.use(route.name, route.Router);
        }
        // Register 404 route for fallback
        const fallback = require("./routes/custom");
        this.app.use(fallback.name, fallback.Router);
    }
    _checkRoutes() {
        // Manual checking because the structure for 404 is weird
        if (!this.config.theme[404])
            console.warn(
                `No key found in the theme object for "404", falling back to the default one`
            );
        for (let routeFile of readdirSync(join(__dirname, "routes")).filter((e) =>
            e.endsWith(".js")
        )) {
            if (["auth.js", "custom.js"].includes(routeFile)) continue;
            const route = require(`./routes/${routeFile}`);
            let routeName;
            switch (route.name) {
                case "/":
                    routeName = "home";
                    break;
                case "/manage":
                    routeName = "guild";
                    break;
                default:
                    routeName = route.name.split("/")[1];
            }
            if (!this.config.theme[routeName])
                console.warn(
                    `No key found in the theme object for "${route.name}", falling back to the default one`
                );
        }
    }

    _start() {
        try {
            this.app.listen(this.app.get("port"));
        } catch (e) {
            throw new Error(e);
        }
    }

    /**
     * Register a command
     * @param name - The name of the command.
     * @param description - A description of the command.
     * @param usage - The usage string for the command.
     */
    registerCommand(name, description, usage) {
        this._commands.push({ name, description, usage });
    }

    /**
     * Adds a text input to the settings page
     * @param name - The name of the setting. This is the name that will be used to access the setting.
     * @param description - A description of the setting.
     * @param validator - A function that takes the input and returns a boolean indicating whether the
     * input is valid.
     * @param setter - a function that takes a value and sets the setting.
     * @param getter - A function that returns the value of the setting.
     */
    addTextInput(name, description, validator, setter, getter) {
        this._settings.push({
            name,
            description,
            type: "text input",
            validator,
            set: setter,
            get: getter,
        });
    }

    /**
     * Adds a boolean input to the settings page
     * @param name - The name of the setting.
     * @param description - A description of the setting.
     * @param setter - a function that takes a boolean value and sets the setting to that value.
     * @param getter - A function that returns the current value of the setting.
     */
    addBooleanInput(name, description, setter, getter) {
        this._settings.push({ name, description, type: "boolean input", set: setter, get: getter });
    }
    
    /**
     * Adds a color input to the settings page
     * @param name - The name of the setting. This is the name that will be used to access the setting.
     * @param description - A description of the setting.
     * @param setter - a function that takes a string and sets the value of the setting.
     * @param getter - A function that returns the current value of the setting.
     */
    addColorInput(name, description, setter, getter) {
        this._settings.push({ name, description, type: "color input", set: setter, get: getter });
    }

    /**
     * It adds a selector to the settings page
     * @param name - The name of the setting. This is the name that will be used to access the setting.
     * @param description - A description of the setting.
     * @param getSelectorEntries - a function that returns an array of couples [id, value].
     * @param setter - a function that takes a value and sets the setting.
     * @param getter - A function that returns the current value of the setting.
     */
    addSelector(name, description, getSelectorEntries, setter, getter) {
        this._settings.push({
            name,
            description,
            type: "selector",
            getSelectorEntries,
            set: setter,
            get: getter,
        });
    }
    /**
     * 
     * @param {Modal} modal 
     */
    addModal(modal) {
        this._settings.push({
            name: modal.options.title,
            type: 'modal',
            modalOptions: modal.options,
            modalSettings: modal.settings
        })
    }
}

class Modal {
    constructor(options) {
        this.settings = [];
        this.options = {
            title: options?.title || "Modal",
            openButtonLabel: options?.openButtonLabel || "Open Modal",
            closeButtonLabel: options?.closeButtonLabel || "Close",
            saveButtonLabel: options?.saveButtonLabel || "Save",
        }
    }
    
    /**
     * Adds a text input to the Modal
     * @param name - The name of the setting. This is the name that will be used to access the setting.
     * @param description - A description of the setting.
     * @param validator - A function that takes the input and returns a boolean indicating whether the
     * input is valid.
     * @param setter - a function that takes a value and sets the setting.
     * @param getter - A function that returns the value of the setting.
     */
    addTextInput(name, description, validator, setter, getter) {
        this.settings.push({
            name,
            description,
            type: "text input",
            validator,
            set: setter,
            get: getter,
        });
    }
    /**
     * Adds a boolean input to the Modal
     * @param name - The name of the setting.
     * @param description - A description of the setting.
     * @param setter - a function that takes a boolean value and sets the setting to that value.
     * @param getter - A function that returns the current value of the setting.
     */
    addBooleanInput(name, description, setter, getter) {
        this.settings.push({ name, description, type: "boolean input", set: setter, get: getter });
        
    }
    /**
     * Adds a color input to the Modal
     * @param name - The name of the setting. This is the name that will be used to access the setting.
     * @param description - A description of the setting.
     * @param setter - a function that takes a string and sets the value of the setting.
     * @param getter - A function that returns the current value of the setting.
     */
    addColorInput(name, description, setter, getter) {
        this.settings.push({ name, description, type: "color input", set: setter, get: getter });
        
    }
    /**
     * It adds a selector to the Modal
     * @param name - The name of the setting. This is the name that will be used to access the setting.
     * @param description - A description of the setting.
     * @param getSelectorEntries - a function that returns an array of couples [id, value].
     * @param setter - a function that takes a value and sets the setting.
     * @param getter - A function that returns the current value of the setting.
     */
    addSelector(name, description, getSelectorEntries, setter, getter) {
        this.settings.push({
            name,
            description,
            type: "selector",
            getSelectorEntries,
            set: setter,
            get: getter,
        });
        
    }
}

exports.Dashboard = Dashboard;
exports.Modal = Modal