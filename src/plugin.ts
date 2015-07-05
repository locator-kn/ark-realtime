import {initLogging, log} from './logging'

export interface IRegister {
    (server:any, options:any, next:any): void;
    attributes?: any;
}

export default
class Realtime {
    socketio:any;
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

        server.dependency(['ark-database'], (server, continueRegister) => {

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
            next();
        });


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

            if(!socket.client.request && socket.client.request.headers.cookie) {
                return
            }

            this.getCookieInformation(socket.client.request.headers.cookie, (err, data) => {
                if(err || !data._id) {
                    return
                }
                log('New user online: ' + data._id);
                userId = data._id;
                this.createNameSpace(userId);
                if(this.namespaces[data._id]) {;

                    // to make sure that datastructure is valid
                    this.createNameSpace(userId);

                    // add socket client to list
                    this.namespaces[userId].userSocketIds.push(socket.id);
                    this.onConnection(userId, socket);
                }
            });


            socket.on('disconnect', () => {
                this.namespaces[userId].userSocketIds = this._.remove(this.namespaces[userId].userSocketIds, (elem) => {
                   return elem === socket.id;
                });

                this.userChange(userId, false);
                log('user' + userId + 'has left');
                for (var key in this.namespaces[userId]) {
                    if (this.namespaces[userId].hasOwnProperty(key)) {

                        // don't persist the socket
                        if (key !== 's' || key !== 'userSocketIds') {
                            this.updateDatabasesReadState(userId, key, this.namespaces[userId][key].conversation_id);
                        }
                    }
                }

                // destroy datastructure if disconnecting connection was the last connection by this user. BOOOM
                if(!this.namespaces[userId].userSocketIds.length) {
                    delete this.namespaces[userId];
                }
            });


        });

    }

    onConnection(namespace, socket) {
        this.userChange(namespace, true);

        // get conversations and build up transient namespace
        this.db.getConversationsByUserId(namespace, (err, conversations) => {
            if (err) {
                console.error('Error while creating transient namespace');
                return;
            }
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
        });

        this.registerMessageAck(socket);

    }

    registerMessageAck(socket) {
        // when sending ack

        socket.on('message_ack', (data) => {
            // write
            if (this.namespaces[data.from] && this.namespaces[data.from][data.opponent]) {
                this.namespaces[data.from][data.opponent].transient = true;
                log('Ack for read message --> set transient flag to true and update db if needed');
                this.updateDatabasesReadState(data.from, data.opponent, data.conversation_id);
            } else {
                log('Ack for read message, but opp is offline, updating database directly');
                this.updateReadState(data.from, data.conversation_id, true);
            }
        });
    }

    getCookieInformation(cookie:string, callback) {
        var reg = new RegExp('[; ]ark_session=([^\\s;]*)');

        var def = this.statehoodArkDef;
        var ark_session = cookie.match(reg)[0];
        def.parse(ark_session, function (err, state, failed) {
            console.log('err', err);
            console.log('state', state);
            console.log('failed', failed);
            if (state) {
                var session = state['ark_session'];
                return callback(null, session);
            }
            callback(err);
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
        if (!this.namespaces[namespace]) {
            var data = {};
            data[namespace + '_read'] = false;
            log('opp not online, update database');
            this.db.updateDocumentWithCallback(message.conversation_id, data, (err, data) => {
                if (err) {
                    log('Error updating databse', err);
                }
                log('updated', data);
            });
            return;
        }

        // send transient flag to false
        if (this.namespaces[namespace][message.from]) {
            this.namespaces[namespace][message.from].transient = false;
            log('Sending message and setting transient flag to false');
        }

        // wait 10 seconds before updating db
        setTimeout(() => {
            this.updateDatabasesReadState(message.to, message.from, message.conversation_id);
        }, 500);

        // send message
        message = this.transformMessage(message);
        //this.namespaces[namespace].s.emit(event, message);
        // iterate over all available socketIoIds and send message
        this.namespaces[namespace].userSocketIds.forEach((socketId) => {
           this.io.sockets.to(socketId).emit(event, message);
        });

    };

    updateDatabasesReadState(from, opponent, conversation_id) {
        if (!this.namespaces[from] || !this.namespaces[from][opponent]) {
            log('user went offline, unable to persist');
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
        this.db.updateDocumentWithCallback(conversation_id, data, (err, data) => {
            if (err) {
                console.error('Updating database failed', err)
            }
            log('database updated with value: ', readState)
        });
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
            log('Error: Failed to load plugin (Realtime):', error);
        }
    }
}