'use strict';
var readConfig = require('read-config'),
    config = readConfig('config.json');
var AWS = require("aws-sdk");
AWS.config.update({
    region: config.awsRegion,
});
const EventEmitter = require('events');
class AwsSupportEmitter extends EventEmitter { };
const awsSupportEmitter = new AwsSupportEmitter();
var request = require('request');
var dateFormat = require('dateformat');

//Walking through array of accounts and invoking getAndUpdateCases with prepared params and credentials 
function walkThroughAccounts() {
    let accountsProcessed = 0;
    config.awsIamAccountArns.forEach(function (account) {
        let awsCentralAccessCreds = new AWS.TemporaryCredentials({
            RoleArn: account.arn,
        });
        let awsSupportParams = {
            afterTime: getIsoTimeBack(),
            includeCommunications: true,
            includeResolvedCases: true,
            maxResults: 50
        };
        console.log('Getting records for account: ' + account.name);
        getCases(awsCentralAccessCreds, awsSupportParams);
        accountsProcessed++;
        if (config.awsIamAccountArns.length == accountsProcessed) {
            sendSnsMessage(`arn:aws:sns:${config.awsRegion}:${config.awsAccountId}:${config.snsTopicName}`, { message: "getAndUpdateCases ready" });
        }
    }, this);
}

//Recursive function list through AWS cases for specified account
var getCases = function (awsCentralAccessCreds, awsSupportParams) {
    //us-east-1 is the region used for support cases api
    let support = new AWS.Support({ apiVersion: '2013-04-15', region: 'us-east-1', credentials: awsCentralAccessCreds });

    support.describeCases(awsSupportParams, function (err, data) {
        if (err) {
            console.log(err, err.stack);
            return;
        }
        awsSupportEmitter.emit('get_cases_ready', data.cases, support);

        //Going recursively via all pages
        if (data.hasOwnProperty("nextToken")) {
            console.log(`Got nextToken data.nextToken on cases listing`);
            awsSupportParams.nextToken = data.nextToken;
            //calling itself in nextToken exist
            getCases(awsCentralAccessCreds, awsSupportParams);

        }
    });
};

//This event Emitter formats communications got from AWS Api and feeds the Dynamo table
awsSupportEmitter.on('get_cases_ready', function (cases, supportInstance) {
    cases.forEach(function (supportCase) {
        let communicationsParams = {
            caseId: supportCase.caseId,
            maxResults: 100
        };

        let i = 0;
        let walkThroughCommunications = function (communicationsParams) {
            supportInstance.describeCommunications(communicationsParams, function (err, allRecentCommunications) {
                if (err) {
                    console.log(err, err.stack);
                    return;
                }
                //Reversing the communications so that the newest message has max ID and the first one goes with ID - 0
                allRecentCommunications.communications.reverse();

                //Feeding the communications table
                allRecentCommunications.communications.forEach(function (communication) {

                    //Communication ID consist of case Id and sort order number
                    communication.CommunicationId = supportCase.caseId + '-' + i;

                    //Getting displayId and subject from the core case
                    communication.displayId = supportCase.displayId;
                    communication.subject = supportCase.subject;

                    //Assuming this is new item for which JiraUpdated supposed to be 0
                    communication.JiraUpdated = 0;

                    //The sort order which is used later to publish SQS messages in correct order
                    communication.Sortorder = i;
                    i++;
                    addNewItem(communication, 'CommunicationId')

                });
            });
        }
        walkThroughCommunications(communicationsParams);
    }, this);

});

/*
This function will make an object containing sorted arrays of communications.
After the object it filled in - async Jira update is called for each case
*/
function processCommunications(jiraUpdated = 0) {
    //Querying Dynamo table for cases ready to be added to Jira
    var params = {
        TableName: config.dynamoTableName,
        IndexName: 'JiraUpdated-timeCreated-index',
        KeyConditionExpression: 'JiraUpdated=:update_status AND timeCreated > :after_date',
        ExpressionAttributeValues: {
            ':after_date': getIsoTimeBack(),
            ':update_status': jiraUpdated
        }
    };

    var documentClient = new AWS.DynamoDB.DocumentClient();

    documentClient.query(params, function (err, data) {
        if (err) {
            console.log(err);
            return;
        }
        //Sorting the array
        let items = data.Items.sort(function (a, b) {
            return a.displayId - b.displayId || a.Sortorder - b.Sortorder;
        });
        let itemsProcessed = 0;
        let commsObj = {}; //Object which will contain arrays of sorted communications
        let lastDisplayId = null;
        //Sync iteration, to keep order 
        for (let i = 0; i < items.length; i++) {
            (function (cntr) {
                let message = items[cntr];
                if (message.displayId != lastDisplayId) {
                    commsObj[message.displayId] = new Array();
                }
                commsObj[message.displayId].push(message);
                itemsProcessed++;
                lastDisplayId = message.displayId;

                if (itemsProcessed === items.length) {
                    for (var displayId in commsObj) {

                        //Assuming that jiraUpdated ==0 means query used for AWS->Jira sync. Otherwise Jira->AWS is invoked.
                        if (jiraUpdated == 0) {
                            findJiras(commsObj[displayId], displayId, updateJira);
                        }
                        else {
                            findJiras(commsObj[displayId], displayId, sendReply);
                        }

                    }
                }
            })(i);
        }
    });
}

//Asynchronously searches for Jira IDs by specified AWS support case ID
function findJiras(communicationsArr, displayId, callback) {
    console.log(`${callback.name}: Querying Jira with AWS Support Reference: ${displayId}`);
    request({
        url: `${config.jiraApiHost}/search?jql='${config.jiraAwsFieldName1.name}'=${displayId} OR '${config.jiraAwsFieldName2.name}'=${displayId}`,
        rejectUnauthorized: false,
        headers: {
            'Authorization': `Basic ${config.jiraApiKey}`,
            'Content-Type': 'application/json'
        }
    }, function (error, response, body) {
        if (error) {
            console.log(error);
            return;
        }

        let jsonResponse = JSON.parse(body);
        if (response.statusCode == 200 && jsonResponse.total != 0) {
            jsonResponse.issues.forEach(function (issue) {
                //verifying if this was second custom field reference (needed later for colorizing)
                callback(communicationsArr, issue, (issue.fields[config.jiraAwsFieldName2.id] == displayId));
            })
        };
    });
}

//synchronously update Jira with AWS comments
function updateJira(communicationsArr, issue, awsRef2) {
    let jiraId = issue.key;
    let i = 0;
    let comment = communicationsArr[i];

    (function addComment(comment) {
        i++;
        //Comment's BGColor should be different for different AWS references to simplify readability
        if (awsRef2) {
            var titleBGColor = "#2e7dba";
        } else {
            var titleBGColor = "#ff9900";
        }

        console.log(`${comment.CommunicationId}: Updating ticket: ${jiraId}`);
        //Preparing comment message
        let date = dateFormat(comment.timeCreated, "dddd, dS mmmm yyyy HH:MM");
        //Removing default AWS text
        comment.body = comment.body.split('Check out the AWS Support Knowledge Center, a knowledge base of articles and videos that answer customer questions about AWS services')[0];
        let json_body = {
            body: `{panel:title=AWS Case: ${comment.displayId} - ${date} - ${comment.subject}|borderStyle=solid|borderColor=#000000|titleBGColor=${titleBGColor}}${comment.body}{panel}`
        }
        //Sending the request
        request({
            url: `${config.jiraApiHost}/issue/${jiraId}/comment`,
            rejectUnauthorized: false,
            method: 'POST',
            body: JSON.stringify(json_body),
            headers: {
                'Authorization': `Basic ${config.jiraApiKey}`,
                'Content-Type': 'application/json'
            }
        }, function (error, response, body) {
            if (error) {
                console.log(error);
                return;
            }

            if (response.statusCode == 201) {
                console.log(`${comment.CommunicationId}: Comment successfully added to: ${jiraId}`);

                //Asynchronously setting JiraUpdated so it won't appear in the next iteration
                updateItem({ CommunicationId: comment.CommunicationId }, 'JiraUpdated', 1);

                if (communicationsArr.length > i) {
                    addComment(communicationsArr[i]);
                }
            } else {
                console.log(`${comment.CommunicationId}: Posting comment failed on: ${jiraId}`);
                console.log(response);
            }
        });
    })(comment);
}

function sendReply(communicationsArr, issue, awsRef2) {
    //Getting all comments for specified issue
    request({
        url: `${config.jiraApiHost}/issue/${issue.key}/comment`,
        rejectUnauthorized: false,
        method: 'GET',
        headers: {
            'Authorization': `Basic ${config.jiraApiKey}`,
            'Content-Type': 'application/json'
        }
    }, function (error, response, body) {
        if (error) {
            console.log(error);
            return;
        }

        if (response.statusCode == 200) {
            let jsonResponse = JSON.parse(body);
            if (jsonResponse.total >= 1) {

                let pattern, awsComment, accountId;

                let newCommunicationId = 0;
                let comment = jsonResponse.comments[0];
                let i = 0;

                (function processComment(comment) {
                    i++;
                    if (awsRef2) {
                        //caseId must be specified in case of two references.
                        pattern = new RegExp(`(#DearAWS\\[${communicationsArr[0].displayId}\\])((.|[\r\n])+)`, 'mgi');
                    }
                    else {
                        pattern = new RegExp(`(#DearAWS)((.|[\r\n])+)`, 'mgi');
                    }

                    awsComment = pattern.exec(comment.body);

                    if (Array.isArray(awsComment) && typeof awsComment[2] !== 'undefined') {
                        let commentText = awsComment[2];

                        //Getting account ID based on caseId
                        let accountIdPattern = new RegExp(`(case-)(\\d+)(-.*?)`, 'mg');
                        accountId = accountIdPattern.exec(communicationsArr[0].caseId);
                        accountId = accountId[2];
                        let caseInfo = `Account ID: ${accountId} \n ticket: ${communicationsArr[0].displayId}  \n Comment: ${commentText}`;
                        console.log(`Posting AWS comment - ${caseInfo}`);

                        postCommentToAws(accountId, communicationsArr[0].caseId, commentText).then(function (awsResponse) {
                            console.log(`Case has been successfully updated in AWS! (${caseInfo})`);
                            console.log(commentText);

                            //updating dynamo so comment won't be visible on regular iterations
                            let now = new Date();
                            let date = now.toISOString();
                            let dynamoItem = communicationsArr[0];
                            dynamoItem.CommunicationId = `${dynamoItem.caseId}-${(communicationsArr.length + newCommunicationId)}`;
                            dynamoItem.body = commentText;
                            dynamoItem.timeCreated = date;
                            dynamoItem.JiraUpdated = 1;
                            dynamoItem.Sortorder = (communicationsArr.length + newCommunicationId);
                            addNewItem(dynamoItem, 'CommunicationId');
                            newCommunicationId++;

                            let formattedBody;
                            if (awsRef2) {
                                formattedBody = { body: `#SenttoAWS[${communicationsArr[0].displayId}]:\n${commentText}` };
                            }
                            else {
                                formattedBody = { body: `#SenttoAWS:\n${commentText}` };
                            }

                            //Editing Jira comment so we can see that reply has been sent to AWS
                            request({
                                url: `${config.jiraApiHost}/issue/${issue.key}/comment/${comment.id}`,
                                rejectUnauthorized: false,
                                method: 'PUT',
                                body: JSON.stringify(formattedBody),
                                headers: {
                                    'Authorization': `Basic ${config.jiraApiKey}`,
                                    'Content-Type': 'application/json'
                                }
                            }, function (error, response, body) {
                                if (error) {
                                    console.log(error);
                                    return;
                                }

                                if (response.statusCode == 200) {
                                    console.log(`Comment has been replaced with #SenttoAWS for ${issue.key}`);
                                    if (jsonResponse.comments.length > i) {
                                        processComment(jsonResponse.comments[i]);
                                    }
                                }
                            });

                        }).catch(function (error) {
                            console.log(error);
                        });
                    }
                    else {
                        if (jsonResponse.comments.length > i) {
                            processComment(jsonResponse.comments[i]);
                        }
                    }
                })(comment);
            }
        }

    });
}

//A promise function which simply posts reply to AWS support.
function postCommentToAws(accountId, caseId, comment) {
    return new Promise(function (resolve, reject) {
        for (var key in config.awsIamAccountArns) {
            let arnObj = config.awsIamAccountArns[key];

            if (arnObj.arn.indexOf(accountId) >= 0) {
                console.log(`Input account ${accountId}, Found ARN ${arnObj.arn}`);
                let awsCentralAccessCreds = new AWS.TemporaryCredentials({
                    RoleArn: arnObj.arn
                });

                let support = new AWS.Support({ apiVersion: '2013-04-15', region: 'us-east-1', credentials: awsCentralAccessCreds });

                var params = {
                    communicationBody: comment,
                    caseId: caseId
                };

                support.addCommunicationToCase(params, function (err, data) {
                    if (err) {
                        return reject(err);
                    }
                    resolve(data);
                });
            }
        };
    });
}

//Helper function making date string including shift stated in config
function getIsoTimeBack() {
    //Making afterTime ISO date
    let date = new Date();
    date.setDate(date.getDate() - config.daysToScan);
    return date.toISOString();
}

//Helper function adds new item only into Dynamo table
function addNewItem(item, Id) {
    let dynamoClient = new AWS.DynamoDB.DocumentClient();
    let params = {
        TableName: config.dynamoTableName,
        ConditionExpression: `attribute_not_exists (${Id})`,
        Item: item,
        ReturnValues: "ALL_OLD"
    }
    dynamoClient.put(params, function (err, data) {
        if (err) {
            if (err.code == 'ConditionalCheckFailedException') {
                console.log(`Item ${item[Id]}  (${item.displayId}) will not be added into database since it already exist.`);
            }
            else {
                console.error("Unable to add item. Error JSON:", JSON.stringify(err, null, 2));
            }
            return;
        }
        console.log(`Item ${item[Id]} (${item.displayId}) has been successfully added into database.`);
    });
}

//Helper function adds or updates key for Dynamo item
function updateItem(hash, key, value) {
    let dynamoClient = new AWS.DynamoDB.DocumentClient();
    var params = {
        TableName: config.dynamoTableName,
        Key: hash,
        UpdateExpression: 'set #a = :x',
        ExpressionAttributeNames: { '#a': key },
        ExpressionAttributeValues: {
            ':x': value
        }
    };

    var documentClient = new AWS.DynamoDB.DocumentClient();

    documentClient.update(params, function (err, data) {
        if (err) {
            console.log(err);
            return;
        }
        console.log(`${JSON.stringify(hash)} has been successfully updated in Dynamo with key: ${key} and value: ${value}`);
    });
}

//Helper function used to invoke JiraHandler function
function sendSnsMessage(arn, messageJson) {
    var sns = new AWS.SNS();
    messageJson.default = 'SnsMessage';

    setTimeout(function () { //letting all dynamo operations to finish
        sns.publish({
            Message: JSON.stringify(messageJson),
            MessageStructure: 'json',
            TargetArn: arn
        }, function (err, data) {
            if (err) {
                console.log(err.stack);
                return;
            }
            console.log('SNS sent to: ' + arn);
            console.log(data);
        });
    }, 5000);
}

exports.DynamoHandler = function () {
    walkThroughAccounts();
}

exports.JiraHandler = function () {
    processCommunications(0); //Add AWS comments (AWS->Jira)
    processCommunications(1); //Open case to AWS (Jira->AWS)
}