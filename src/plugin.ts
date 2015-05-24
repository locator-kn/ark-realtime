export interface IRegister {
    (server:any, options:any, next:any): void;
    attributes?: any;
}

export default
class Realtime {
    socketio:any;
    io:any;

    constructor() {
        this.register.attributes = {
            pkg: require('./../../package.json')
        };

        this.socketio = require('socket.io');
    }

    register:IRegister = (server, options, next) => {
        server = server.select('realtime');
        server.bind(this);
        this._register(server, options);

        this.io = this.socketio(server.listener);
        this.exportApi(server);
        next();
    };

    private _register(server, options) {
        server.route({
            method: 'GET',
            path: '/connect/me',
            config: {
                handler: (request, reply) => {
                    var userId:string = request.auth.credentials._id;
                    this.createNameSpace(userId);
                    reply({message: 'namespace created: ' + userId});
                    this.emitMessage(userId, 'welcome');
                }
            }
        });
    }

    createNameSpace(namespace:string) {
        var nsp = this.io.of('/' + namespace);
        nsp.on('connection', socket => {
            console.log('someone connected');
        });
    }

    emitMessage(namespace:string, message) {
        if(typeof message === 'string') {
            message = {message: message};
        }
        this.io.of('/' + namespace).emit('new_message', message);
    }

    exportApi(server) {
        server.expose('emitMessage', this.emitMessage);
    }

    errorInit(error) {
        if (error) {
            console.log('Error: Failed to load plugin (Realtime):', error);
        }
    }
}