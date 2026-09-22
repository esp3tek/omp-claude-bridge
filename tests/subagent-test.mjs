// Subagentes en paralelo y, después, un turno normal: el fallo era que al
// terminar los subagentes el proveedor claude-bridge desaparecía del registro.
import { spawn } from "node:child_process";
import { join } from "node:path";
const model = process.argv[2] ?? "claude-bridge/claude-haiku-4-5";
const child = spawn("omp", ["--mode","rpc","--no-session","--auto-approve","--model",model,"--cwd",join(process.env.TEMP,"bridge-smoke")], { stdio:["pipe","pipe","pipe"], shell:true, env:{...process.env, CLAUDE_BRIDGE_DEBUG:"1"} });
const send=(o)=>child.stdin.write(JSON.stringify(o)+"\n");
let buf="",step=0,bad=false; const t0=Date.now(); const log=(m)=>console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] ${m}`);
const steps=[
  ()=>send({id:"p0",type:"prompt",message:"Palabra clave: NISPERO. Lanza DOS subagentes en paralelo con la herramienta task: uno lee high.yml, otro lee med.yml; cada uno resume su fichero en una frase."}),
  ()=>send({id:"p1",type:"prompt",message:"Sin herramientas: ¿cuál era la palabra clave? Solo la palabra."}),
];
child.stdout.on("data",(d)=>{buf+=d;let i;while((i=buf.indexOf("\n"))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);let o;try{o=JSON.parse(l)}catch{continue}
  if(o.type==="ready") steps[step++]();
  else if(o.type==="response"&&!o.success){bad=true;log(`FALLO ${o.command}: ${String(o.error).slice(0,200)}`)}
  else if(o.type==="message_end"&&o.message?.role==="assistant"){const t=(o.message.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");if(t)log("answer: "+JSON.stringify(t.slice(0,90)))}
  else if(o.type==="agent_end"){ if(step<steps.length) setTimeout(()=>steps[step++](),1500); else child.stdin.end(); }
}});
setTimeout(()=>{log("timeout");child.kill();process.exit(2)},240000);
child.on("exit",()=>process.exit(bad?1:0));
