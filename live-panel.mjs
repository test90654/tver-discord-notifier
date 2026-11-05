export class LivePanel {
  constructor({render,update}){this.render=render;this.update=update;this.busy=false;this.previous=null;}
  async refresh(){
    if(this.busy)return;
    const payload=this.render();
    const current=JSON.stringify(payload);
    if(current===this.previous)return;
    this.busy=true;
    try{await this.update(payload);this.previous=current;}
    catch{console.error('Could not update progress panel; will retry.');}
    finally{this.busy=false;}
  }
}
