import {initLogging, log, logErr} from './logging'

export interface IRegister {
    (server:any, options:any, next:any): void;
    attributes?: any;
}

export default
class Realtime {
    socketio:any;
    redis:any;
    boom:any;
    io:any;
    _:any;
    statehood:any;
    statehoodArkDef:any;
    stats:any = {};

    namespaces = {};

    db:any;

    USER_ONLINE_EVENT:string = 'new_user_online';
    USER_OFFLINE_EVENT:string = 'user_went_offline';

    CLIENT_EVENTS:any = {
        NEW_MESSAGE: 'new_message'
    };

    constructor(env) {
        this.register.attributes = {
            pkg: require('./../../package.json')
        };

        this.boom = require('boom');
        this.socketio = require('socket.io');
        this._ = require('lodash');
        this.statehood = require('statehood');

        this.statehoodArkDef = new this.statehood.Definitions({
            encoding: 'iron',
            password: env['COOKIE_SECRET'],
            isHttpOnly: true
        });
    }

    register:IRegister = (server, options, next) => {
        //server = server.select('realtime');
        server.bind(this);

        initLogging(server);

        server.dependency('ark-database', (server, continueRegister) => {

            this.db = server.plugins['ark-database'];

            this._register(server, options);
            this.exportApi(server);
            this.io = this.socketio(server.listener);
            // set max listeners to 0 to remove the actual limit
            // keep an eye on that
            this.io.httpServer.setMaxListeners(0);
            this.io.sockets.setMaxListeners(0);
            this.createStatsNamespace();
            this.registerSocketListener();
            continueRegister();
        });
        next();
    };

    createStatsNamespace() {
        this.stats.ns = this.io.of('/stats');
        this.stats.usersOnline = 0;
    }

    userChange(user, wentOnline:boolean) {
        if (wentOnline) {

            this.stats.usersOnline++;
            this.stats.ns.emit(this.USER_ONLINE_EVENT, {user: user, usersOnline: this.stats.usersOnline});
        } else {
            this.stats.usersOnline--;

            this.stats.ns.emit(this.USER_OFFLINE_EVENT, {user: user, usersOnline: this.stats.usersOnline});
        }
    }

    private _register(server, options) {
        server.route({
            method: 'GET',
            path: '/connect/me',
            config: {
                handler: (request, reply) => {
                    var userId:string = request.auth.credentials._id;
                    this.createNameSpace(userId);
                    reply({
                        message: 'namespace created: ' + userId,
                        namespace: '/' + userId
                    });
                }
            }
        });

        server.route({
            method: 'GET',
            path: '/users/stats',
            config: {
                handler: (request, reply) => {
                    if (!request.auth.credentials.isAdmin) {
                        return reply(this.boom.unauthorized(''))
                    }
                    reply({
                        usersOnline: this.stats.usersOnline,
                        statsNamespace: '/stats',
                        events: [this.USER_ONLINE_EVENT, this.USER_OFFLINE_EVENT]
                    })
                }
            }
        });
    }

    registerSocketListener() {


        //this.io.set('authorization', (handshakeData, accept) => {
        //    if (handshakeData.headers.cookie) {
        //        this.getCookieInformation(handshakeData.headers.cookie, (err, data) => {
        //            accept(data, !err);
        //        });
        //    } else {
        //        console.log('no cookie');
        //        return accept('No cookie transmitted.', false);
        //    }
        //});

        this.io.on('connection', socket => {
            var userId;

            if (!socket.client.request && socket.client.request.headers.cookie) {
                return;
            }

            if (!socket.client.request.headers.cookie) {
                return;
            }

            this.getCookieInformation(socket.client.request.headers.cookie, (err, data) => {
                if (err || !data._id) {
                    logErr('error while trying to get cookie information', err);
                    return
                }
                userId = data._id;
                this.createNameSpace(userId);
                if (this.namespaces[data._id]) {
                    // to make sure that datastructure is valid
                    this.createNameSpace(userId);

                    // add socket client to list
                    this.namespaces[userId].userSocketIds.push(socket.id);
                    this.onConnection(userId, socket);
                }
            });


            socket.on('disconnect', () => {
                if (!this.namespaces[userId]) {
                    logErr('user disconnect but is not in datastructure');
                    return;
                }
                this.namespaces[userId].userSocketIds = this._.remove(this.namespaces[userId].userSocketIds, (elem) => {
                    return elem !== socket.id;
                });

                this.userChange(userId, false);
                for (var key in this.namespaces[userId]) {
                    if (this.namespaces[userId].hasOwnProperty(key)) {

                        // don't persist the socket
                        if (key !== 's' || key !== 'userSocketIds') {
                            this.updateDatabasesReadState(userId, key, this.namespaces[userId][key].conversation_id);
                        }
                    }
                }

                // destroy datastructure if disconnecting connection was the last connection by this user. BOOOM
                if (!this.namespaces[userId].userSocketIds.length) {
                    delete this.namespaces[userId];
                }
            });


        });

    }

    onConnection(namespace, socket) {
        this.userChange(namespace, true);

        // get conversations and build up transient namespace
        this.db.getConversationsByUserId(namespace)
            .then(conversations => {

                if (!conversations.length) {
                    log('no converstions available');
                    return;
                }
                conversations.forEach((con:any) => {
                    var opponent;

                    if (con.user_1 === namespace) {
                        opponent = con.user_2;
                    } else {
                        opponent = con.user_1;
                    }

                    // save status of read/unread message
                    this.namespaces[namespace][opponent] = {
                        transient: con[namespace + '_read'],
                        persistent: con[namespace + '_read'],
                        conversation_id: con._id
                    }
                });
            }).catch(err => {
                logErr('Error while creating transient namespace');
                return;
            });


        this.registerMessageAck(socket);

    }

    registerMessageAck(socket) {
        // when sending ack

        socket.on('message_ack', (data) => {
            // write
            if (this.namespaces[data.from] && this.namespaces[data.from][data.opponent]) {
                this.namespaces[data.from][data.opponent].transient = true;
                this.updateDatabasesReadState(data.from, data.opponent, data.conversation_id);
            } else {
                this.updateReadState(data.from, data.conversation_id, true);
            }
        });
    }

    getCookieInformation(cookie:string, callback) {
        var reg = new RegExp('[; ]ark_session=([^\\s;]*)');

        var def = this.statehoodArkDef;
        var cm = cookie.match(reg);
        if (!cm || !cm.length) {
            return callback('no cookie found');
        }
        var ark_session = cm[0];
        def.parse(ark_session, function (err, state, failed) {
            if (err) {
                callback(err);
                return logErr('while cookie parsing:', err, failed);
            }
            if (state) {
                var session = state['ark_session'];
                return callback(null, session);
            }
        });
    }

    createNameSpace(namespace:string) {
        // create new object in datastructure if not exists
        if (!this.namespaces[namespace]) {
            this.namespaces[namespace] = {};

            // create array u for users with the same id (mult. tabs, mobile + web, etc.)
            // we save the according socketIds
            this.namespaces[namespace].userSocketIds = [];

        }
    }

    emitMessage = (namespace:string, message) => {
        this.emit(namespace, this.CLIENT_EVENTS.NEW_MESSAGE, message);
    };

    emit = (namespace:string, event:string, message) => {
        this.emitToUser(message.from, message, event);

        if (!this.namespaces[namespace]) {
            var data = {};
            data[namespace + '_read'] = false;
            this.db.updateConversation(message.conversation_id, data)
                .catch(err => logErr('Error updating conversation', err));
            return;
        }

        // send transient flag to false
        if (this.namespaces[namespace][message.from]) {
            this.namespaces[namespace][message.from].transient = false;
        }

        // wait 10 seconds before updating db
        setTimeout(() => {
            this.updateDatabasesReadState(message.to, message.from, message.conversation_id);
        }, 500);

        // send message
        message = this.transformMessage(message);
        //this.namespaces[namespace].s.emit(event, message);
        // iterate over all available socketIoIds and send message
        this.emitToUser(namespace, message, event);
    };

    emitToUser(user, message, event) {
        if (this.namespaces[user] && this.namespaces[user].userSocketIds && this.namespaces[user].userSocketIds.length) {
            this.namespaces[user].userSocketIds.forEach((socketId) => {
                this.io.sockets.to(socketId).emit(event, message);
            });
        }
    }

    updateDatabasesReadState(from, opponent, conversation_id) {
        if (!this.namespaces[from] || !this.namespaces[from][opponent]) {
            return;
        }
        var trans = this.namespaces[from][opponent].transient;
        if (trans !== this.namespaces[from][opponent].persistent) {
            this.namespaces[from][opponent].persistent = trans;
            // write to database
            this.updateReadState(from, conversation_id, trans);
        } else {
            log('transient value is not different from persistent value, no need to update: value', trans)
        }
    }

    updateReadState(from:string, conversation_id:string, readState:boolean) {
        var data = {};
        data[from + '_read'] = readState;
        this.db.updateConversation(conversation_id, data)
            .catch(err => logErr('Error updating conversation', err));
    }

    exportApi(server) {
        server.expose('emitMessage', this.emitMessage);

        server.expose('getClientEventsList', this.getClientEventsList);
        server.expose('emit', this.emit);
        server.expose('broadcast', this.broadcast);
    }

    getClientEventsList = () => {
        return this.CLIENT_EVENTS;
    };

    broadcast = (event:string, message) => {
        message = this.transformMessage(message);
        this.io.emit(event, message);
    };

    private transformMessage(message) {
        if (typeof message === 'string') {
            message = {message: message};
        }
        return message;
    }

    errorInit(error) {
        if (error) {
            logErr('Error: Failed to load plugin (Realtime):', error);
        }
    }
}