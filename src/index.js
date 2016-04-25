import nconf from "./wrio_nconf.js";
import multer from 'multer';
import fs from 'fs';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import {loginWithSessionId, getTwitterCredentials, getLoggedInUser, wrap, wrioAuth} from './wriologin.js';
import titterPicture from './titter-picture';
import titterSender from './titter-sender';
import express from 'express';
import {init} from './utils/db.js';
import {dumpError} from './utils/utils.js';
import request from 'superagent';
import startPhantom from './widget-extractor/phantom.js';

var DOMAIN = nconf.get('db:workdomain');

var app = require("./wrio_app.js")
    .init(express);

app.ready = function() {};

init()
    .then(function(db) {
        console.log("Connected correctly to database");
        var server = require('http')
            .createServer(app)
            .listen(nconf.get("server:port"), function(req, res) {
                console.log('app listening on port ' + nconf.get('server:port') + '...');
                app.use('/api/', (require('./api/api-search.js')));
                app.use('/api/', (require('./api/api-reply.js')));
                server_setup(db);
                console.log("Application Started!");
                app.ready();
            });
    })
    .catch(function(err) {
        console.log('Error connect to database:' + err.code + ': ' + err.message);
    });


function server_setup(db) {

    //wrioLogin = require('./wriologin')(db);

    app.set('views', __dirname + '/views');
    app.set('view engine', 'ejs');
    //var SessionStore = require('express-mysql-session');
    var SessionStore = require('connect-mongo')(session);
    var cookie_secret = nconf.get("server:cookiesecret");
    app.use(cookieParser(cookie_secret));
    var sessionStore = new SessionStore({
        db: db
    });
    app.use(session({

        secret: cookie_secret,
        saveUninitialized: true,
        store: sessionStore,
        resave: true,
        cookie: {
            secure: false,
            domain: DOMAIN,
            maxAge: 1000 * 60 * 60 * 24 * 30
        },
        key: 'sid'
    }));

    var p3p = require('p3p');
    app.use(p3p(p3p.recommended));
    app.use(express.static(__dirname + '/'));


    app.get('/iframe/', async(request, response) => {

        var origin = request.query.origin;
        console.log('ORIGIN: ', origin);

        try {
            var user = await getLoggedInUser(request.sessionID);
            if (user.temporary) {
                throw new Error("Temporary user, allow to login");
            }
            console.log("User found " + user);
            response.render('create.ejs', {
                "user": user,
                "userID": request.query.id,
                "host": decodeURIComponent(origin)
            });

        } catch (e) {
            console.log("User not found:",e);
            response.render('create.ejs', {
                "error": "Not logged in",
                "user": undefined,
                "host": decodeURIComponent(origin),
                "userID": request.query.id
            });
        }

    });


    app.get('/', async(request, response) => {
        response.sendFile(__dirname + '/views/index.htm');
    });


    app.get('/logoff', function(request, response) {
        console.log("Logoff called");
        response.clearCookie('sid', {
            'path': '/',
            'domain': DOMAIN
        });
        response.send("OK");
        //response.redirect('/?create');

    });


    app.get('/callback', function(request, response) {
        console.log("Our callback called");
        response.render('callback', {});
    });

    app.get('/get_widget_id', function(request,response) {
        var login = request.query.login;
        var password = request.query.password;
        var query = request.query.query;

        if (!login || !password || ! query) {
            return response.status(403).send("Wrong parameters");
        }

        startPhantom(login,password,query).then(function(code) {
           response.send("Got code"+code);
        });
    });


    /* Request donate from webgold via api*/

    function requestDonate(from, to, amount) {
        return new Promise((resolve, reject) => {
            var proto = 'https:';
            if (nconf.get('server:workdomain') == '.wrioos.local') {
                proto = 'http:';
            }
            var url = proto+ '//webgold' +
                nconf.get('server:workdomain') + "/api/webgold/donate?amount=" +
                amount + "&to=" + to + "&from=" + from;

            var login = nconf.get("service2service:login");
            var pass =  nconf.get("service2service:password");

            console.log(url);
            request
                .get(url)
                .auth(login, pass)
                .end((err, res) => {
                    if (err) {
                        if (!res) {
                            console.log(err);
                            return reject(err);
                        }
                        if (res.body) {
                            if (res.body.error) {
                                return reject(res.body.error);
                            }
                        }
                    return reject(err);
                }
                resolve(res.body);
            });
        });

    }

    async function sendTitterComment (cred, amount, text, images, title,message) { // sends comment and
        console.log("SendTitterComment");

        if (text) {
            var filename = await titterPicture.drawCommentP(text);
            var data = await titterSender.uploadP(cred, filename);

            try {
                console.log(data);
                data = JSON.parse(data);
            } catch (e) {}
            if (data['errors']) {
                throw new Error("Upload failed, check twitter credentials ");
            }
            images.unshift(data.media_id_string);
            console.log("Sending images: ", images);
        }
        return await titterSender.replyP(cred, title + '\n' + message + ' Donate ' + amount + ' WRG', images);
    }



    app.post('/sendComment', multer().array('images[]'), wrioAuth, wrap(async(request, response) => {
            var text = request.body.text;
            var title = request.body.title || '';
            var message = request.body.comment || '';
            var ssid = request.sessionID || '';
            var images = [];

            console.log("Sending comment " + message);
            var cred = getTwitterCredentials(request);
            var amount = request.query.amount;
            var to = request.query.to;

            var amountUser = 0;
            var fee = 0;
            var feepercent = 0;

            if (amount > 0 && to) {
                console.log("Starting donate");
                var r = await requestDonate(request.user.wrioID, to, amount);
                console.log("Donate result", r);
                amountUser = r.amountUser / 100;
                fee = r.fee / 100;
                feepercent = r.feePercent;
            } else {
                amount = 0;
            }

            console.log("got keys", cred);
            if (request.files.length > 0 || text) { // handle attached files
                console.log("handling attached files:");
                var files = request.files;
                for (var file in files) {
                    var data = await titterSender.uploadP(cred, files[file].buffer);
                    try {
                        data = JSON.parse(data);
                    } catch (e) {}
                    images.push(data.media_id_string);
                }
                await sendTitterComment(cred, amount,text,images,title,message);
            }
            var donateResult = {
                "status": 'Done',
                "donated": amount,
                amountUser: amountUser,
                fee: fee,
                feePercent: feepercent
            };
            console.log("Donate result: ", donateResult);
            response.send(donateResult);


        }));

    app.use(function (err, req, res, next) {
        dumpError(err);
        res.status(403).send("There was error processing your request");
    });

    console.log("Titter server config finished");
};

module.exports = app; // For unit testing purposes
