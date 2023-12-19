// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as lark from '@larksuiteoapi/node-sdk';
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import {
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
  } from "@aws-sdk/client-dynamodb";

  const dbclient = new DynamoDBClient();
const snsclient = new SNSClient();
const topicArn = process.env.SNS_TOPIC_ARN;
const lark_token = process.env.LARK_TOKEN;
const dynamodb_tb = process.env.DB_TABLE;

const larkclient = new lark.Client({
    appId: process.env.LARK_APPID,
    appSecret: process.env.LARK_APP_SECRET,
    appType: lark.AppType.SelfBuild,
});

const queryDynamoDb = async (key) => {
    const params = {
      Key: { message_id: { S: key } },
      TableName: dynamodb_tb,
    };
    const command = new GetItemCommand(params);
    try {
      const results = await dbclient.send(command);
      if (!results.Item) {
        return null;
      } else {
        // console.log(results.Item);
        return JSON.parse(results.Item.payload.S);
      }
    } catch (err) {
      console.error(err);
      return null;
    }
  };
  
  const saveDynamoDb = async (key, payload) => {
    const params = {
      TableName: dynamodb_tb,
      Item: {
        message_id: { S: key },
        payload: { S: JSON.stringify(payload) },
      },
    };
    const command = new PutItemCommand(params);
    try {
      const results = await dbclient.send(command);
      console.log("Items saved success",results);
    } catch (err) {
      console.error(err);
    }
  }

// update lark 卡片消息
const updateLarkCard = ({card_template, actions, ref_doc}) =>{
    let card_json = {...card_template};
    if (actions.thumbup === 'click'){
        card_json.elements[1].actions[0].text.content = "已赞😊";  //改变状态是已赞
        card_json.elements[1].actions[0].value.thumbup = "cancel"; //再点击就是cancel操作
        card_json.elements[1].actions[1].text.content = "👎";  //恢复点踩状态
        card_json.elements[1].actions[1].value.thumbdown = "click"; //恢复点踩状态
    } else if (actions.thumbdown === 'click'){
        card_json.elements[1].actions[1].text.content = "已踩😭";  //改变状态是已赞
        card_json.elements[1].actions[1].value.thumbdown = "cancel"; //再点击就是cancel操作
        card_json.elements[1].actions[0].text.content = "👍";  //恢复初始状态
        card_json.elements[1].actions[0].value.thumbup = "click"; //恢复初始状态
    }else if (actions.thumbup === 'cancel'){
        card_json.elements[1].actions[0].text.content = "👍";  //恢复初始状态
        card_json.elements[1].actions[0].value.thumbup = "click"; //恢复初始状态
    }else if (actions.thumbdown === 'cancel'){
        card_json.elements[1].actions[1].text.content = "👎";  //改变状态是已赞
        card_json.elements[1].actions[1].value.thumbdown = "click"; //再点击就是cancel操作
    }else if (actions.checkref === 'click'){
        card_json.elements[1].actions[2].text.content = "隐藏引用";  //改变状态是已赞
        card_json.elements[1].actions[2].value.checkref = "cancel";  //改变状态是已赞
        card_json.elements.splice(2,0,{ "tag": "hr"}); //从索引2处，删除0个元素，插入 分割线
        card_json.elements.splice(3,0,{ "tag": "markdown", "content":ref_doc }); //从索引3处，删除0个元素，插入 ref doc
    }else if (actions.checkref === 'cancel'){
        card_json.elements[1].actions[2].text.content = "查看引用";  //改变状态是已赞
        card_json.elements[1].actions[2].value.checkref = "click";  //改变状态是已赞
        card_json.elements.splice(3,1); //从索引3处，删除ref doc
        card_json.elements.splice(2,1); //从索引2处，删除分割线
    }
    return card_json;
}

const sendFeedback = async ({method,session_id,msgid,action,user}) =>{
    const client = new LambdaClient();
    let payload;
    if (method === 'post'){
        payload = {
           "method": method,
           "resource":'feedback',
           "body":{
                "msgid": msgid,
                "username":user,
                "session_id":session_id,
                "action":action,
                "feedback":""
           },
        };
    }else if (method === 'delete'){
        payload = {
            "method": method,
            "resource":'feedback',
            "body":{
                "msgid": msgid,
                "session_id":session_id,
           },
         };
    }else{
        console.log('invalid method')
        return;
    }

  
    try{
        const input = {
            FunctionName: process.env.MAIN_FUN_ARN,
            InvocationType: "Event",
            Payload: JSON.stringify({ ...payload }),
          };
          const command = new InvokeCommand(input);
          await client.send(command);
          console.log('update feedback:',payload)
    }catch(error){
        console.error(JSON.stringify(error));
    }
}

export const handler = async(event) => {
    const data = JSON.parse(event.body);
    // console.log(event);
    console.log(data);

    //配置消息卡片的回调url为api_endponint/feedback
    if (event.httpMethod === 'POST' && event.resource === '/feedback'){
        if (data.type === 'url_verification') {
            return {
                statusCode: 200,
                body:JSON.stringify({
                challenge: data.challenge,
                })}
        }

        const user_id = data.user_id;
        const open_message_id = data.open_message_id;
        const dbret = await queryDynamoDb(open_message_id);
        const session_id = dbret.session_id;
        console.log(dbret);
        const actions = {thumbup:data.action.value?.thumbup,
                          thumbdown:data.action.value?.thumbdown,
                          checkref:data.action.value?.checkref,
                          }
        console.log('actions:',actions);
        if (actions.thumbup === 'click' || actions.thumbdown === 'click'){//点赞或者点踩
            const action = actions.thumbup === 'click' ?'thumbs-up':'thumbs-down';
            await sendFeedback({method:'post',session_id:session_id,msgid:dbret.up_message_id,action:action, user:user_id});
        }else if (actions.thumbup === 'cancel' || actions.thumbdown === 'cancel'){//取消点赞或者点踩
            const action = actions.thumbup === 'cancel' ?'thumbs-up':'thumbs-down';
            await sendFeedback({method:'delete',session_id:session_id,msgid:dbret.up_message_id,action:action,user:user_id});
        }
        const updated_card = updateLarkCard({card_template:dbret.card_template,
          actions:actions,
          ref_doc:dbret.ref_doc,
         });
        console.log(updated_card);

        //更新ddb里的卡片信息
        await saveDynamoDb(open_message_id,{...dbret,card_template:updated_card});

        return {
            statusCode: 200,
            body:JSON.stringify(updated_card)
        }
    }

    if (data.type === 'url_verification') {
        return {
                statusCode: 200,
                body:JSON.stringify({
                challenge: data.challenge,
                })}
    }else if (data.header.token === lark_token){
        if (data.header.event_type === 'im.message.receive_v1') {
            // console.log(data);
            const message = data.event.message;
            const msg_type = message.message_type;
            const open_chat_id = message.chat_id;
            const chat_type = message.chat_type;
            const open_id =data.event.sender.sender_id.open_id;
            const user_id = data.event.sender.sender_id.user_id;
            // const msg = JSON.parse(message.content).text;
            
            const command = new PublishCommand({
                TopicArn:topicArn,
                Message:JSON.stringify({
                    msg_type:msg_type,
                    msg:message.content,
                    session_id:`lark_chat_${chat_type}_${open_chat_id}_${user_id}`,
                    open_chat_id: open_chat_id,
                    message_id:message.message_id,
                    open_id:open_id,
                    chat_type:chat_type
                })
            });

            try{
                 await snsclient.send(command);
            }catch(err){
                console.log(JSON.stringify(err));
                await larkclient.im.message.create({
                    params: {
                        receive_id_type: 'chat_id',
                    },
                    data: {
                        receive_id: open_chat_id,
                        content: JSON.stringify({ text: `<at user_id="${user_id}"></at> Internal error` }),
                        msg_type: 'text',
                    },
                });
            }
            return { statusCode: 200, }
        }else if (data.header.event_type === 'im.message.reaction.created_v1') {
            const user_id = data.event.user_id.user_id;
            const ddbret = await queryDynamoDb(data.event.message_id);
            const session_id = ddbret.session_id
            await sendFeedback({method:'post',
                session_id:session_id,
                msgid:data.event.message_id,
                action:data.event.reaction_type.emoji_type,
                user:user_id});

        }else if (data.header.event_type === 'im.message.reaction.deleted_v1') {
            const user_id = data.event.user_id.user_id;
            const ddbret = await queryDynamoDb(data.event.message_id);
            const session_id = ddbret.session_id
            await sendFeedback({method:'delete',
                session_id:session_id,
                msgid:data.event.message_id,
                action:data.event.reaction_type.emoji_type,
                user:user_id});
        }else if (data.header.event_type === 'im.chat.member.user.added_v1'){
            const open_chat_id = data.event.chat_id;
            const welcome_message = process.env.welcome_message??'👏👏👏,欢迎入群，我是小助手，可以帮您找人，问事，查价格等，有什么可以帮您'
            data.event.users.map(async (item) =>{
                const user_id = item.user_id.user_id;
                await larkclient.im.message.create({
                    params: {
                        receive_id_type: 'chat_id',
                    },
                    data: {
                        receive_id: open_chat_id,
                        content: JSON.stringify({ text: `<at user_id="${user_id}"></at> ${welcome_message}` }),
                        msg_type: 'text',
                    },
                });
            });
        }
    }else{
        return {
                 statusCode: 400,
            }
    }
};