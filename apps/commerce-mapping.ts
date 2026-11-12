// Deliberately not JSONPath: own object properties only, no evaluation or arrays.
export const commercialStates=['PENDING','PAID','CANCELLED','REFUNDED','CHARGEBACK'] as const;
export type CommercialState=typeof commercialStates[number];
export type Mapping={auth:'HMAC_SHA256_TIMESTAMP';fields:{event:string;order:string;amount:string;currency:string;status:string;occurred:string;product?:string;offer?:string;checkout?:string;reference?:string};statuses:Record<string,CommercialState>;money:{unit:'MINOR'|'DECIMAL';exponent:number}};
const keys=['event','order','amount','currency','status','occurred'];
export function object(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('object required');return value as Record<string,unknown>;
}
export function path(value:unknown):string{
 if(typeof value!=='string'||value.length>160||!value.split('.').every(k=>/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k)&&!['__proto__','constructor','prototype'].includes(k))||value.split('.').length>8)throw new TypeError('invalid field path');return value;
}
export function field(payload:unknown,p:string):unknown{
 let value:unknown=payload;
 for(const key of path(p).split('.')){const row=object(value);if(!Object.hasOwn(row,key))throw new TypeError('missing field');value=row[key];}return value;
}
export function mapping(value:unknown):Mapping{
 const data=object(value),fields=object(data.fields),money=object(data.money),statuses=object(data.statuses);
 if(Object.keys(data).sort().join(',')!=='auth,fields,money,statuses'||data.auth!=='HMAC_SHA256_TIMESTAMP'||!keys.every(k=>Object.hasOwn(fields,k))||!['product','offer','checkout'].some(k=>Object.hasOwn(fields,k))||Object.keys(fields).some(k=>![...keys,'product','offer','checkout','reference'].includes(k))||Object.values(fields).some(v=>!path(v))||!['MINOR','DECIMAL'].includes(String(money.unit))||!Number.isInteger(money.exponent)||Number(money.exponent)<0||Number(money.exponent)>3||Object.keys(money).sort().join(',')!=='exponent,unit'||Object.keys(statuses).length<1||Object.keys(statuses).length>32||!Object.hasOwn(statuses,Object.keys(statuses).find(k=>statuses[k]==='PAID')??'')||Object.entries(statuses).some(([k,v])=>!/^[-A-Za-z0-9_]{1,40}$/.test(k)||!commercialStates.includes(v as CommercialState)))throw new TypeError('invalid mapping');
 return JSON.parse(JSON.stringify(data)) as Mapping;
}
export function identifier(value:unknown):string{if(typeof value!=='string'||!/^[-A-Za-z0-9_]{1,128}$/.test(value))throw new TypeError('invalid identifier');return value;}
export function moneyMinor(value:unknown,unit:'MINOR'|'DECIMAL',exponent:number):number{
 // Decimal values must be strings: binary floating point is never rounded into money.
 if(unit==='MINOR'){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>1e12)throw new TypeError('invalid minor amount');return value;}
 if(typeof value!=='string'||! /^(0|[1-9][0-9]{0,12})(\.[0-9]{1,3})?$/.test(value))throw new TypeError('decimal string required');
 const [whole,fraction='']=value.split('.');if(fraction.length>exponent)throw new TypeError('excess precision');
 const result=BigInt(whole)*10n**BigInt(exponent)+BigInt(fraction.padEnd(exponent,'0')||'0');if(result>1000000000000n)throw new TypeError('amount too large');return Number(result);
}
export function normalize(config:Mapping,payload:unknown){
 const get=(key:keyof Mapping['fields'])=>field(payload,config.fields[key]!);
 const status=get('status');if(typeof status!=='string'||!Object.hasOwn(config.statuses,status))throw new TypeError('unmapped status');
 const currency=get('currency'),occurred=get('occurred');
 if(typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency)||typeof occurred!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(occurred)||!Number.isFinite(Date.parse(occurred))||new Date(occurred).toISOString()!==occurred)throw new TypeError('invalid commercial fields');
 let reference=false;if(config.fields.reference){try{const value=get('reference');reference=typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);}catch{/* Optional attribution never gates authenticated ordinary sales. */}}
 return {event:identifier(get('event')),order:identifier(get('order')),product:config.fields.product?identifier(get('product')):'',offer:config.fields.offer?identifier(get('offer')):'',checkout:config.fields.checkout?identifier(get('checkout')):'',amount:moneyMinor(get('amount'),config.money.unit,config.money.exponent),currency,status:config.statuses[status],occurred,reference_present:reference};
}
export function sampleShape(value:unknown,depth=0):unknown{
 if(depth>=5)return '[depth limit]';
 if(Array.isArray(value))return '[array]';
 if(value&&typeof value==='object')return Object.fromEntries(Object.values(value).slice(0,24).map((v,index)=>['field_'+(index+1),sampleShape(v,depth+1)]));
 return value===null?'[null]':`[${typeof value}]`;
}
