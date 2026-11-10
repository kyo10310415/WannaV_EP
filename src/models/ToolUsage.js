const db=require('../config/database');
const TOOLS=[
  ['obs-master','OBSマスター'],['vtube-studio','VTube Studioマスター'],
  ['streaming-gear','配信機材コンシェルジュ'],['kanau','かなうさん'],
  ['youtube-analyst','YouTubeアナリティクス分析官'],['youtube-game-strategy','YouTubeゲーム配信 戦略分析官']
];
async function forStudents(userIds){
  const ids=[...new Set(userIds.filter(id=>Number.isSafeInteger(Number(id))&&Number(id)>0).map(Number))];
  if(!ids.length)return new Map();
  const {rows}=await db.query(`SELECT user_id,tool_key,count(*)::integer AS total,
    count(*) FILTER (WHERE created_at>=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo'
      AND created_at<(date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo')+INTERVAL '1 month') AT TIME ZONE 'Asia/Tokyo')::integer AS current_month
    FROM tool_usage WHERE user_id=ANY($1::integer[]) AND status='completed' GROUP BY user_id,tool_key`,[ids]);
  return new Map(ids.map(id=>[id,TOOLS.map(([key,name])=>{const row=rows.find(r=>Number(r.user_id)===id&&r.tool_key===key);return {key,name,total:row?.total||0,current_month:row?.current_month||0};})]));
}
module.exports={TOOLS,forStudents};
