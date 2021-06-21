const express = require("express");
const router = express.Router();
const db = require("../../db");
const path = require("path");
var passport = require('passport')
var LocalStrategy = require('passport-local').Strategy;
require('custom-env').env()
let {
    roomsInfo
} = require("../config");



passport.use(new LocalStrategy(
    // the first parameter is an optional object with options
    {
        // when using the local strategy you MUST name your keys usernameField and passwordField. By default they will have values of "username" and "password", 
        // but if you are using something like an email instead of a username or have different name attribute values in your form, modifying the optional object is essential for authentication to work.
        usernameField: 'username',
        passwordField: 'password',
        // by default this option is set to false, but when specified to true, the first parameter of the verify callback will be the request object. 
        // This is quite useful if you want to see if your application has multiple strategies and you want to see if a user is already logged in with an existing strategy, if they are you can simply associate the new strategy with them (eg. they have put in their username/password, but then try to authenticate again through twitter)
        passReqToCallback: true,
    },
    // the second parameter to the constructor function is known as the verify callback. Since we have set passReqToCallback as true, the first parameter is the request object. The second parameter is the username which comes from user entered data in a form, the third second parameter is the plain text password which comes from user entered data in a form. The fourth parameter is a callback function that will be invoked depending on the result of the verify callback.
    function verifyCallback(req, username, password, done) {
        // find a user in the database based on their username
        db.User.findOne({
            username: username
        }, function (err, user) {
            // if there is an error with the DB connection (NOT related to finding the user successfully or not, return the callback with the error)
            if (err) return done(err);
            // if the user is not found in the database or if the password is not valid, do not return an error (set the first parameter to the done callback as null), but do set the second parameter to be false so that the failureRedirect will be reached.

            // validPassword is a method WE have to create for every object created from our Mongoose model (we call these instance methods or "methods" in Mongoose)
            if (!user) {
                return done(null, false);
            }
            user.comparePassword(password, function (err, isMatch) {
                if (isMatch) {
                    return done(null, user);
                } else {
                    return done(null, false);
                }
            })
            // if the user has put in the correct username and password, move onto the next step and serialize! Pass into the serialization function as the first parameter the user who was successfull found (we will need it's id to store in the session and cookie)

        });
    }
));



router.get("/", async (req, res, next) => {
    try {
        // const results = await db.query("SELECT * FROM users");
        // console.log(results.rows)
        return res.status(200).sendFile(path.join(__dirname, "../../src/main.html"));
    } catch (error) {
        return next(error)
    }
});

router.post("/sign-up", async (req, res, next) => {

    try {
        let data = {
            pass: hashedPassword,
            gameWon: 0,
            matchPlayed: 0,
            pointsRecord: 0,
            room: null,
            hand: null,
            points: 0,
            role: null,
            admin: false
        };

        const result = await db.query(
            "INSERT INTO users (username, data) VALUES ($1, $2) RETURNING *",
            [req.body.username, JSON.stringify(data)]
        );

        // let's create a token using the sign() method
        const token = jwt.sign({
            id: result.rows[0].id
        }, SECRET);

        res.setHeader("Authorization", token);
        return res.json(result.rows[0]);
    } catch (err) {
        return next(err);
    }
});

router.post("/log-in", async (req, res, next) => {
    try {
        const results = await db.query("SELECT * FROM users WHERE username=$1 LIMIT 1", [req.body.username]);
        if (results.rows[0].data.pass === req.body.pass.toString()) {
            const token = jwt.sign({
                id: results.rows[0].id
            }, SECRET);

            return res.json({
                pass: true,
                token: token
            })
        } else return res.json({
            pass: false
        })
        // return res.status(200).sendFile(path.join(__dirname, "../../src/main.html"));
    } catch (error) {
        return next(error)
    }
});

router.get("/help", (req, res) => {
    res.sendFile(path.join(__dirname, "../../src/help.html"));
});

router.get(`/room/:roomName`, (req, res, next) => {
    try {
        if (
            roomsInfo.rooms.open[req.params.roomName] ||
            roomsInfo.rooms.hide[req.params.roomName]
        ) {
            return res.sendFile(path.join(__dirname, "../../src/room.html"));
        } else next();
    } catch (error) {
        next(error);
    }
});

module.exports = router;