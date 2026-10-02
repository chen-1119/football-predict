"""Standalone reliability plot from verified report bins; no data retrieval."""
import json,sys,pathlib
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

def main():
    source=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2])
    report=json.loads(source.read_text(encoding='utf8'))
    assert report.get('productionEligible') is False
    assert not out.exists(),'Refuse to replace existing evidence plot'
    fig,axes=plt.subplots(1,3,figsize=(13,4.5),sharex=True,sharey=True)
    for ax,outcome in zip(axes,['home','draw','away']):
        ax.plot([0,1],[0,1],color='#9AA4B2',linestyle='--',label='Ideal')
        for key,label,color in [('publishedModel','Frozen model','#0055AA'),('sameDecisionMarket','Same-decision market','#D45B00')]:
            bins=[b for b in report['metrics'][key]['reliability'][outcome] if b['n']]
            x=[b['meanProbability'] for b in bins];y=[b['observedFrequency'] for b in bins]
            ax.plot(x,y,marker='o',linewidth=1.5,color=color,label=label)
            for b in bins:ax.annotate(str(b['n']),(b['meanProbability'],b['observedFrequency']),xytext=(3,5 if key=='publishedModel' else -11),textcoords='offset points',fontsize=7,color=color)
        ax.set(title=outcome.capitalize(),xlabel='Mean predicted probability',xlim=(0,1),ylim=(0,1))
        ax.grid(alpha=.2)
    axes[0].set_ylabel('Observed frequency')
    axes[0].legend(loc='upper left',fontsize=8)
    fig.suptitle(f"Frozen probability review | n={report['rows']}, match days={report['matchDays']}",fontsize=13)
    fig.text(.5,.015,'Labels are bin sample counts. Descriptive retrospective sample; no promotion or causal claim.',ha='center',fontsize=9)
    fig.tight_layout(rect=(0,.05,1,.94))
    out.parent.mkdir(parents=True,exist_ok=True);fig.savefig(out,dpi=160);plt.close(fig)
    print(json.dumps({'plot':str(out),'rows':report['rows'],'productionEligible':False}))

if __name__=='__main__':main()
