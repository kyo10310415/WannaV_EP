// USD estimates only. Never treat missing usage or prices as free usage.
function rate(name){const raw=process.env[name];if(raw===undefined||String(raw).trim()==='')return null;const n=Number(raw);return Number.isFinite(n)&&n>=0?n:null;}
function exchangeRate(){const n=rate('TOOLS_USD_TO_JPY');return n>0?n:null;}
function estimate({usage,usageKnown=true,partialUsage=false,searches=0,imageCalls=0,containers=0,uncertain=false,imageModel=null,imageSize=null}={}){
 const parts=[];
 const add=(name,quantity,unit,scale=1)=>{if(quantity===0)return;const price=rate(unit);parts.push({name,quantity,unit_usd:price,usd:price===null?null:quantity*price/scale});};
 const valid=usage&&Number.isSafeInteger(usage.input_tokens)&&usage.input_tokens>=0&&Number.isSafeInteger(usage.output_tokens)&&usage.output_tokens>=0;
 if(valid&&(usageKnown||partialUsage)){
  const cached=usage.input_tokens_details?.cached_tokens??0;
  if(Number.isSafeInteger(cached)&&cached>=0&&cached<=usage.input_tokens){add('input',usage.input_tokens-cached,'TOOLS_INPUT_USD_PER_MILLION',1e6);add('cached',cached,'TOOLS_CACHED_USD_PER_MILLION',1e6);add('output',usage.output_tokens,'TOOLS_OUTPUT_USD_PER_MILLION',1e6);}else parts.push({name:'invalid_usage',usd:null});
 }else parts.push({name:'missing_usage',usd:null});
 add('search',searches,'TOOLS_SEARCH_USD_PER_CALL');
 add('image_average',imageCalls,'TOOLS_IMAGE_USD_PER_CALL');
 add('container_1gb',containers,'TOOLS_CODE_INTERPRETER_USD_PER_CONTAINER');
 if(!usageKnown||uncertain)parts.push({name:'unknown_usage',usd:null});
 const known=parts.filter(p=>Number.isFinite(p.usd)),complete=parts.every(p=>Number.isFinite(p.usd));
 const sum=known.reduce((n,p)=>n+p.usd,0);
 return {usd:complete?sum:null,details:{version:1,complete,known_usd:known.length||complete?sum:null,parts,image_model:imageModel,image_size:imageSize,image_method:imageCalls?'configured_average':null}};
}
function jpy(usd,fx=exchangeRate()){return usd===null||usd===undefined||fx===null?null:Number(usd)*fx;}
module.exports={rate,exchangeRate,estimate,jpy};
