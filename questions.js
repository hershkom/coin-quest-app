/* ===== LEARNING QUESTION BANK =====
   Minecraft-themed quiz content for the "מכרה הידע" (Knowledge Mine) feature.
   Math questions (level 1-3) are procedurally generated so the pool is
   effectively infinite; English and science are hand-written since they need
   real vocabulary/facts, not templated numbers. Every question needs a
   deterministic `id` so per-question spaced-repetition progress (box/lastSeen)
   survives regeneration across sessions. */

function _mkMathQ(id,level,q,answer){
  return {id,subject:'math',level,type:'typed-number',q,answer:String(answer)};
}
// Procedural math bank: deterministic seed per (level,index) so ids are stable.
function generateMathQuestions(){
  const out=[];
  let seed=1;
  function rnd(lo,hi){ seed=(seed*9301+49297)%233280; return lo+Math.floor((seed/233280)*(hi-lo+1)); }
  // Level 1: sums/differences to 10, Minecraft-flavored word problems.
  const itemsL1=['יהלומים 💎','בלוקים 🧱','חיצים 🏹','תפוחים 🍎','אזמלים ⛏️'];
  for(let i=0;i<40;i++){
    const item=itemsL1[i%itemsL1.length];
    const a=rnd(1,7), b=rnd(1,10-a);
    if(i%2===0){
      out.push(_mkMathQ('m1g_'+i,1,`לסטיב יש ${a} ${item} והוא מצא עוד ${b}. כמה יש לו עכשיו?`,a+b));
    }else{
      const total=a+b;
      out.push(_mkMathQ('m1g_'+i,1,`לאלכס יש ${total} ${item} והיא נתנה ${b} לחבר. כמה נשארו לה?`,total-b));
    }
  }
  // Level 2: sums/differences to 20, simple multiplication by 2.
  const itemsL2=['בלוקי אבן 🪨','גושי ברזל ⚙️','עצים 🌳','חצי לבנים 🧱'];
  for(let i=0;i<40;i++){
    const item=itemsL2[i%itemsL2.length];
    if(i%3===2){
      const rows=rnd(2,5), perRow=rnd(2,4);
      out.push(_mkMathQ('m2g_'+i,2,`בונים קיר עם ${rows} שורות ו-${perRow} ${item} בכל שורה. כמה ${item} צריך בסך הכל?`,rows*perRow));
    }else{
      const a=rnd(3,15), b=rnd(1,20-a);
      out.push(_mkMathQ('m2g_'+i,2,`יש ${a+b} ${item} בתיבה, ולוקחים ${b}. כמה נשארו?`,a));
    }
  }
  // Level 3: multi-step, multiplication/division up to 12, sums to 50.
  const itemsL3=['יהלומים 💎','חצי זהב ✨','לוחות עץ 🪵'];
  for(let i=0;i<40;i++){
    const item=itemsL3[i%itemsL3.length];
    if(i%3===0){
      const per=rnd(3,9), boxes=rnd(2,6);
      out.push(_mkMathQ('m3g_'+i,3,`יש ${boxes} תיבות, ובכל תיבה ${per} ${item}. כמה ${item} יש בסך הכל?`,per*boxes));
    }else if(i%3===1){
      const total=rnd(20,50), used=rnd(5,total-5);
      out.push(_mkMathQ('m3g_'+i,3,`לילד יש ${total} ${item}, הוא השתמש ב-${used} לבניית מגדל. כמה נשארו לו?`,total-used));
    }else{
      const groups=rnd(2,9), per=rnd(2,9);
      out.push(_mkMathQ('m3g_'+i,3,`מחלקים ${groups*per} ${item} שווה בשווה בין ${groups} חברים. כמה מקבל כל אחד?`,per));
    }
  }
  return out;
}

const ENGLISH_QUESTIONS=[
  // Level 1: single Minecraft-flavored vocabulary words.
  {id:'e1_001',subject:'english',level:1,type:'choice',q:'איך אומרים "חרב" באנגלית? ⚔️',choices:['Sword','Shield','Stone'],answer:'Sword'},
  {id:'e1_002',subject:'english',level:1,type:'choice',q:'איך אומרים "עץ" באנגלית? 🌳',choices:['Tree','Water','Rock'],answer:'Tree'},
  {id:'e1_003',subject:'english',level:1,type:'choice',q:'איך אומרים "מים" באנגלית? 💧',choices:['Fire','Water','Sand'],answer:'Water'},
  {id:'e1_004',subject:'english',level:1,type:'choice',q:'איך אומרים "אבן" באנגלית? 🪨',choices:['Stone','Grass','Wood'],answer:'Stone'},
  {id:'e1_005',subject:'english',level:1,type:'choice',q:'איך אומרים "יהלום" באנגלית? 💎',choices:['Gold','Diamond','Iron'],answer:'Diamond'},
  {id:'e1_006',subject:'english',level:1,type:'choice',q:'איך אומרים "כלב" באנגלית? 🐶',choices:['Cat','Dog','Cow'],answer:'Dog'},
  {id:'e1_007',subject:'english',level:1,type:'choice',q:'איך אומרים "בית" באנגלית? 🏠',choices:['House','Door','Wall'],answer:'House'},
  {id:'e1_008',subject:'english',level:1,type:'choice',q:'איך אומרים "אש" באנגלית? 🔥',choices:['Ice','Fire','Smoke'],answer:'Fire'},
  {id:'e1_009',subject:'english',level:1,type:'choice',q:'איך אומרים "אדום" באנגלית? 🔴',choices:['Red','Blue','Green'],answer:'Red'},
  {id:'e1_010',subject:'english',level:1,type:'choice',q:'איך אומרים "אחת" באנגלית? 1️⃣',choices:['Two','One','Three'],answer:'One'},
  {id:'e1_011',subject:'english',level:1,type:'choice',q:'איך אומרים "חתול" באנגלית? 🐱',choices:['Cat','Cow','Pig'],answer:'Cat'},
  {id:'e1_012',subject:'english',level:1,type:'choice',q:'איך אומרים "שמש" באנגלית? ☀️',choices:['Moon','Sun','Star'],answer:'Sun'},
  {id:'e1_013',subject:'english',level:1,type:'choice',q:'איך אומרים "כחול" באנגלית? 🔵',choices:['Blue','Yellow','Red'],answer:'Blue'},
  {id:'e1_014',subject:'english',level:1,type:'choice',q:'איך אומרים "דלת" באנגלית? 🚪',choices:['Door','Window','Roof'],answer:'Door'},
  {id:'e1_015',subject:'english',level:1,type:'choice',q:'איך אומרים "ירוק" באנגלית? 🟢',choices:['Green','Purple','Black'],answer:'Green'},
  // Level 2: short phrases / Minecraft mobs.
  {id:'e2_001',subject:'english',level:2,type:'choice',q:'איך אומרים "קרימר" (מפלצת ירוקה) באנגלית? 💚',choices:['Zombie','Creeper','Skeleton'],answer:'Creeper'},
  {id:'e2_002',subject:'english',level:2,type:'choice',q:'איך אומרים "פרה" באנגלית? 🐄',choices:['Cow','Sheep','Chicken'],answer:'Cow'},
  {id:'e2_003',subject:'english',level:2,type:'choice',q:'מה זה "Iron" בעברית? ⚙️',choices:['ברזל','זהב','נחושת'],answer:'ברזל'},
  {id:'e2_004',subject:'english',level:2,type:'choice',q:'מה זה "Village" בעברית? 🏘️',choices:['כפר','הר','נהר'],answer:'כפר'},
  {id:'e2_005',subject:'english',level:2,type:'choice',q:'איך אומרים "לבנות" באנגלית? 🧱',choices:['Build','Break','Run'],answer:'Build'},
  {id:'e2_006',subject:'english',level:2,type:'choice',q:'מה זה "Sky" בעברית? ☁️',choices:['שמיים','ים','אדמה'],answer:'שמיים'},
  {id:'e2_007',subject:'english',level:2,type:'choice',q:'איך אומרים "לחפור" באנגלית? ⛏️',choices:['Dig','Fly','Swim'],answer:'Dig'},
  {id:'e2_008',subject:'english',level:2,type:'choice',q:'מה זה "Night" בעברית? 🌙',choices:['לילה','בוקר','צהריים'],answer:'לילה'},
  {id:'e2_009',subject:'english',level:2,type:'choice',q:'איך אומרים "מהר" באנגלית? 🏃',choices:['Fast','Slow','Big'],answer:'Fast'},
  {id:'e2_010',subject:'english',level:2,type:'choice',q:'מה זה "Friend" בעברית? 🤝',choices:['חבר','אויב','זר'],answer:'חבר'},
  {id:'e2_011',subject:'english',level:2,type:'choice',q:'איך אומרים "בטוח" באנגלית? 🛡️',choices:['Safe','Danger','Fast'],answer:'Safe'},
  {id:'e2_012',subject:'english',level:2,type:'choice',q:'מה זה "Bridge" בעברית? 🌉',choices:['גשר','מגדל','מנהרה'],answer:'גשר'},
  {id:'e2_013',subject:'english',level:2,type:'choice',q:'איך אומרים "מפה" באנגלית? 🗺️',choices:['Map','Book','Key'],answer:'Map'},
  {id:'e2_014',subject:'english',level:2,type:'choice',q:'מה זה "Cave" בעברית? 🕳️',choices:['מערה','גבעה','עמק'],answer:'מערה'},
  {id:'e2_015',subject:'english',level:2,type:'choice',q:'איך אומרים "אור" באנגלית? 💡',choices:['Light','Dark','Shadow'],answer:'Light'},
  // Level 3: short sentences / plurals.
  {id:'e3_001',subject:'english',level:3,type:'choice',q:'איזו מילה מתאימה: "I ___ a house yesterday." (בניתי בית אתמול)',choices:['built','build','building'],answer:'built'},
  {id:'e3_002',subject:'english',level:3,type:'choice',q:'הרבים של "sheep" (כבשה) הוא:',choices:['sheeps','sheep','sheepes'],answer:'sheep'},
  {id:'e3_003',subject:'english',level:3,type:'choice',q:'"The creeper is ___ me." (רודף אחריי) — איזו מילה חסרה?',choices:['chasing','chased','chase'],answer:'chasing'},
  {id:'e3_004',subject:'english',level:3,type:'choice',q:'"There are three ___ in my inventory." (תרמילים) — מה השם הנכון ליהלומים ברבים?',choices:['diamond','diamonds','diamonds\'s'],answer:'diamonds'},
  {id:'e3_005',subject:'english',level:3,type:'choice',q:'איזו מילה היא שם תואר (מתארת)? ',choices:['dangerous','danger','endanger'],answer:'dangerous'},
  {id:'e3_006',subject:'english',level:3,type:'choice',q:'"We ___ to the village tomorrow." (נלך מחר)',choices:['went','will go','goes'],answer:'will go'},
  {id:'e3_007',subject:'english',level:3,type:'choice',q:'מה ההיפך מ-"day"?',choices:['light','night','sun'],answer:'night'},
  {id:'e3_008',subject:'english',level:3,type:'choice',q:'"He has ___ apple." — מה מתאים?',choices:['a','an','the'],answer:'an'},
  {id:'e3_009',subject:'english',level:3,type:'choice',q:'מה ההיפך מ-"strong"?',choices:['weak','big','fast'],answer:'weak'},
  {id:'e3_010',subject:'english',level:3,type:'choice',q:'"My favorite animal ___ the wolf." — מה מתאים?',choices:['is','are','am'],answer:'is'},
];

const SCIENCE_QUESTIONS=[
  // Level 1: basic states of matter, day/night, plants.
  {id:'s1_001',subject:'science',level:1,type:'choice',q:'מה קורה לקרח 🧊 כשמחממים אותו?',choices:['הוא נמס למים','הוא נהיה אבן','הוא גדל'],answer:'הוא נמס למים'},
  {id:'s1_002',subject:'science',level:1,type:'choice',q:'מה עוזר לצמח לגדול? 🌱',choices:['מים ושמש','אבנים','חושך'],answer:'מים ושמש'},
  {id:'s1_003',subject:'science',level:1,type:'choice',q:'מתי רואים כוכבים בשמיים? ⭐',choices:['בלילה','בצהריים','בבוקר'],answer:'בלילה'},
  {id:'s1_004',subject:'science',level:1,type:'choice',q:'איזה בעל חיים חי במים? 🐟',choices:['דג','כלב','ציפור'],answer:'דג'},
  {id:'s1_005',subject:'science',level:1,type:'choice',q:'מה קורה למים כשקר מאוד? ❄️',choices:['הם הופכים לקרח','הם נעלמים','הם מתחממים'],answer:'הם הופכים לקרח'},
  {id:'s1_006',subject:'science',level:1,type:'choice',q:'איזה איבר משמש אותנו לראות? 👀',choices:['עיניים','אוזניים','אף'],answer:'עיניים'},
  {id:'s1_007',subject:'science',level:1,type:'choice',q:'מה נותן לנו אור וחום ביום? ☀️',choices:['השמש','הירח','הכוכבים'],answer:'השמש'},
  {id:'s1_008',subject:'science',level:1,type:'choice',q:'איזה חיה יכולה לעוף? 🦅',choices:['ציפור','דג','פרה'],answer:'ציפור'},
  {id:'s1_009',subject:'science',level:1,type:'choice',q:'מה צריך זרע כדי לגדול לצמח? 🌾',choices:['מים, אור ואדמה','מסמרים','זכוכית'],answer:'מים, אור ואדמה'},
  {id:'s1_010',subject:'science',level:1,type:'choice',q:'איזה עונה הכי קרה בישראל? ⛄',choices:['חורף','קיץ','אביב'],answer:'חורף'},
  // Level 2: habitats, simple energy, life cycles.
  {id:'s2_001',subject:'science',level:2,type:'choice',q:'איפה חי דוב קוטב? 🐻‍❄️',choices:['בקרח ובשלג','במדבר','ביער גשם'],answer:'בקרח ובשלג'},
  {id:'s2_002',subject:'science',level:2,type:'choice',q:'מה הופך זחל לפרפר? 🦋',choices:['גולם','ביצה','שורש'],answer:'גולם'},
  {id:'s2_003',subject:'science',level:2,type:'choice',q:'מה קורה כשמערבבים כחול וצהוב? 🎨',choices:['ירוק','אדום','לבן'],answer:'ירוק'},
  {id:'s2_004',subject:'science',level:2,type:'choice',q:'מה נמשך לכיוון מגנט? 🧲',choices:['מתכת (כמו ברזל)','עץ','נייר'],answer:'מתכת (כמו ברזל)'},
  {id:'s2_005',subject:'science',level:2,type:'choice',q:'איזה גז אנחנו נושמים כדי לחיות? 🌬️',choices:['חמצן','פחמן','הליום'],answer:'חמצן'},
  {id:'s2_006',subject:'science',level:2,type:'choice',q:'למה חשוב לצמח שמש? 🌻',choices:['כדי לייצר מזון (פוטוסינתזה)','כדי לישון','כדי לגדול עלים כחולים'],answer:'כדי לייצר מזון (פוטוסינתזה)'},
  {id:'s2_007',subject:'science',level:2,type:'choice',q:'איזה כוח מושך דברים לכיוון הרצפה? ⬇️',choices:['כוח המשיכה','חשמל','אור'],answer:'כוח המשיכה'},
  {id:'s2_008',subject:'science',level:2,type:'choice',q:'מה קורה למים כשמחממים אותם מאוד? 💨',choices:['הם הופכים לאדים','הם הופכים לקרח','הם נעלמים לגמרי'],answer:'הם הופכים לאדים'},
  {id:'s2_009',subject:'science',level:2,type:'choice',q:'איפה חיים דגים? 🐠',choices:['באוקיינוסים ובנהרות','בהרים','במדבר'],answer:'באוקיינוסים ובנהרות'},
  {id:'s2_010',subject:'science',level:2,type:'choice',q:'מה זה שלד? 🦴',choices:['העצמות בגוף','העור','השיער'],answer:'העצמות בגוף'},
  // Level 3: cycles, basic chemistry/physics concepts.
  {id:'s3_001',subject:'science',level:3,type:'choice',q:'מה שם התהליך שבו מים עולים לענן ויורדים כגשם?',choices:['מעגל המים','פוטוסינתזה','כוח המשיכה'],answer:'מעגל המים'},
  {id:'s3_002',subject:'science',level:3,type:'choice',q:'מה קורה לחומר כשעובר משלב מוצק לנוזל?',choices:['היתוך','אידוי','קיפאון'],answer:'היתוך'},
  {id:'s3_003',subject:'science',level:3,type:'choice',q:'איזה כוכב לכת הכי קרוב לשמש?',choices:['כוכב חמה (מרקורי)','כדור הארץ','מאדים'],answer:'כוכב חמה (מרקורי)'},
  {id:'s3_004',subject:'science',level:3,type:'choice',q:'מה מוליך חשמל טוב יותר?',choices:['מתכת','עץ','גומי'],answer:'מתכת'},
  {id:'s3_005',subject:'science',level:3,type:'choice',q:'איזה איבר שואב דם לכל הגוף?',choices:['הלב','הריאות','הכבד'],answer:'הלב'},
  {id:'s3_006',subject:'science',level:3,type:'choice',q:'מה נקרא בעל חיים שאוכל רק צמחים?',choices:['צמחוני (הרביבור)','טורף (קרניבור)','כל-אוכל'],answer:'צמחוני (הרביבור)'},
  {id:'s3_007',subject:'science',level:3,type:'choice',q:'למה סלעי געש (הר געש) פורצים?',choices:['לחץ ומאגמה מתחת לפני הקרקע','רוח חזקה','גשם רב'],answer:'לחץ ומאגמה מתחת לפני הקרקע'},
  {id:'s3_008',subject:'science',level:3,type:'choice',q:'כמה עצמות יש בערך בגוף אדם בוגר?',choices:['206','50','1000'],answer:'206'},
  {id:'s3_009',subject:'science',level:3,type:'choice',q:'מה גורם לגאות ושפל בים?',choices:['משיכת הירח','רוח','דגים'],answer:'משיכת הירח'},
  {id:'s3_010',subject:'science',level:3,type:'choice',q:'מה נקרא הגז שצמחים פולטים ומועיל לבני אדם?',choices:['חמצן','פחמן דו-חמצני','חנקן'],answer:'חמצן'},
];

// Combined bank, built once at load time (math is generated, others are static).
const QUESTION_BANK=[...generateMathQuestions(),...ENGLISH_QUESTIONS,...SCIENCE_QUESTIONS];
