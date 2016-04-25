/**
 * Created by michbil on 23.04.16.
 */
import phantom from 'phantom';
import {dumpError} from '../utils/utils.js';
import fs from 'fs';

var sitepage = null;
var phInstance = null;

var loadInProgress = false;

function delay(ms) {
    return new Promise((resolve, reject) => {
        setTimeout(()=>resolve(),ms);
    });
}

async function waitLoadingToFinish() {
    await delay(1000);
    console.log("Wait",loadInProgress);
    while(loadInProgress) {
        await delay(50);
    }
    await delay(1000);
}

async function setupPhantom(phantom,page) {

    page.property('onConsoleMessage', function(msg) {
        console.log(msg);
    });

    page.property('onLoadStarted', function() {
        loadInProgress = true;
        console.log('Loading started');
    });

    page.property('onLoadFinished', function() {
        loadInProgress = false;
        console.log('Loading finished');
    });

    await page.setting('userAgent', 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/44.0.2403.157 Safari/537.36');
    await page.setting('javascriptEnabled', true);
    await page.setting('loadImages', false);//Script is much faster with this field set to false
    await page.setting('cookiesEnabled',true);
//    await page.setting('javascriptEnabled', true);

    console.log("Settings successfully setup");

}

async function loginTwitter(page,login,pass) {
    console.log('Step 1 - Open Twitter Login page');
    var status = await page.open("https://twitter.com");
    console.log(status);



    console.log('Step 2 - Populate and submit the login form');
    var r = await page.evaluate(function(login,pass) {
        console.log("Logging in");
        document.getElementsByName("session[username_or_email]")[1].value=login;
        document.getElementsByName("session[password]")[1].value=pass;
        document.getElementsByClassName('flex-table-btn')[0].click();
        return "ok";
    },login,pass);
    console.log(r);
}

async function loadTweets(page) {
    console.log("Step 3 - Wait for loading Twitter home page and extract the content");

    var content = await page.property('content');

    fs.writeFileSync('/tmp/page.html',content);

    var result = await page.evaluate(function() {
        console.log("Turbo");
        var pageTweets = document.getElementsByClassName('js-tweet-text');
        console.log("Tweets is",pageTweets);
        console.log(pageTweets.length);
        var result = new Array();
        for(var i=0; i < pageTweets.length; i++){
            result.push(pageTweets[i].innerHTML);
        }
        return result;
    });
  //  console.log("loadres",result);
}



async function createTimeline(page,url) {

    var status = page.open("https://twitter.com/settings/widgets/new/search");
    await waitLoadingToFinish();
    var content = await page.property('content');
    fs.writeFileSync('/tmp/sett.html',content);

    var r = await page.evaluate(function(url) {

        console.log("Creating widget for url");
        document.getElementsByName("timeline_config[query]")[0].value = url;
        var $formactions = document.getElementsByClassName('form-actions')[0].children[0];
        $formactions.click();

        return "ok";
    },url);

    await delay(8000);

    var r = await page.evaluate(function() {
        console.log("Waiting for code to appear");

        var $code = document.getElementById('code');
        if ($code) {
            var retval = $code.value;
            console.log("Got value");
            return retval;
        }

        return "failure";
    });

    return r;



}

    function extractID(code) {
        var regex = /data-widget-id="([0-9]+)"/g;
        var match = regex.exec(code);
        if (match) {
            return match[1];
        }

    }

export default async function startPhantom (login,pass,url) {

    try {
        phInstance = await phantom.create();//["--remote-debugger-port=9000"]); // ["--cookies-file=/tmp/cookies.txt"]);
        var page = await phInstance.createPage();

        await setupPhantom(phInstance,page);

        await loginTwitter(page,login,pass);
        await waitLoadingToFinish();
        await loadTweets(page);
        var code = await createTimeline(page,url);
        console.log("Return value",code);

        page.close();
        await phInstance.exit();

        return extractID(code);

    } catch (error) {
        dumpError(error);
        phInstance.exit();
    }


};

