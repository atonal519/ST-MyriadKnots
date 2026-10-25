import { createCompactApiClient } from '../../src/compact-api-client.js';
import { createTaskRouter } from '../../src/api-routing.js';

// Exercise the real final transport while each runtime fixture supplies only model semantics.
export function processingTransport({ processingPrompt, respond }) {
  const bodies=[];let prefixReads=0;
  return { bodies, prefixReads:()=>prefixReads, async generate(options) {
    const client=createCompactApiClient({processingPrompt:()=>{prefixReads++;return processingPrompt();},fetchImpl:async(_path,request)=>{
      bodies.push(JSON.parse(request.body));const result=await respond(options);
      return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify(result.jsonData??result)},finish_reason:'stop'}]})};
    }});
    const route={kind:'independent',source:'fixture',config:{url:'https://fixture.invalid',key:'fixture',model:'fixture'}};
    return createTaskRouter({resolver:{resolve:()=>route,resolveUtility:()=>route},compactClient:client}).generateUtilityTask(options);
  }};
}
